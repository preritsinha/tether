"""
Tether - FastAPI Backend
Real-time location sharing with WebSocket tracking

Pretty straightforward - REST API for room management,
WebSocket for live location updates.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Dict, List
import json
import os
from datetime import datetime, timedelta
import asyncio
import logging

# Import custom modules
from storage.memory import MemoryStore
from services.room_service import RoomService
from services.ws_manager import ConnectionManager
from utils.ids import generate_room_id, generate_member_id, generate_token
from utils.time import get_utc_now

# Basic logging setup
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# FastAPI app
app = FastAPI(title="Tether", version="2.0.0")

# Environment variables
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")
ROOM_TTL_SECONDS = int(os.getenv("ROOM_TTL_SECONDS", "10800"))  # 3 hours default

logger.info(f"FRONTEND_ORIGIN: {FRONTEND_ORIGIN}")
logger.info(f"ROOM_TTL_SECONDS: {ROOM_TTL_SECONDS}")

# CORS - allow requests from frontend (including mobile access)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        FRONTEND_ORIGIN,
        "http://localhost:3000",
        "http://localhost:5000",
        "http://127.0.0.1:3000",
        "*"  # Allow all origins for mobile development
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize services - using in-memory storage for now
store = MemoryStore()
room_service = RoomService(store, ttl_seconds=ROOM_TTL_SECONDS)
connection_manager = ConnectionManager()

# ============= Pydantic Models =============

class CreateRoomRequest(BaseModel):
    destination_name: str
    destination_lat: float
    destination_lng: float
    duration_minutes: Optional[int] = 180

class JoinRoomRequest(BaseModel):
    name: str

class EndRoomRequest(BaseModel):
    member_id: str
    token: str

# ============= REST Endpoints =============

@app.get("/")
async def root():
    return {
        "app": "Tether",
        "status": "running",
        "websocket": "ws://localhost:8000/ws/rooms/{room_id}?member_id={member_id}&token={token}"
    }

@app.post("/rooms")
async def create_room(req: CreateRoomRequest):
    """
    Create a new room.
    
    Returns: room_id and invite_link
    """
    try:
        room_id = generate_room_id()
        
        room = room_service.create_room(
            room_id=room_id,
            destination_name=req.destination_name,
            destination_lat=req.destination_lat,
            destination_lng=req.destination_lng,
            duration_minutes=req.duration_minutes
        )
        
        invite_link = f"{FRONTEND_ORIGIN}?room={room_id}"
        
        logger.info(f"Room created: {room_id}")
        
        return {
            "room_id": room_id,
            "destination_name": req.destination_name,
            "invite_link": invite_link,
            "expires_at": room.expires_at.isoformat()
        }
    except Exception as e:
        logger.error(f"Error creating room: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/rooms/{room_id}/join")
async def join_room(room_id: str, req: JoinRoomRequest):
    """
    Join an existing room.
    
    Returns: member_id and token for WebSocket connection
    """
    try:
        # Check if room exists
        room = room_service.get_room(room_id)
        if not room:
            raise HTTPException(status_code=404, detail="Room not found")
        
        # Check if room is expired
        if room_service.is_room_expired(room_id):
            raise HTTPException(status_code=410, detail="Room has expired")
        
        # Check member cap
        if len(room.members) >= 10:
            raise HTTPException(status_code=409, detail="Room is full (max 10 members)")
        
        # Create member
        member_id = generate_member_id()
        token = generate_token()
        
        room_service.add_member(
            room_id=room_id,
            member_id=member_id,
            name=req.name,
            token=token
        )
        
        # Set host if first member
        if len(room.members) == 1:
            room.host_member_id = member_id
        
        logger.info(f"Member {member_id} ({req.name}) joined room {room_id}")
        
        return {
            "member_id": member_id,
            "token": token,
            "room_id": room_id
        }
    except HTTPException as e:
        raise
    except Exception as e:
        logger.error(f"Error joining room: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/rooms/{room_id}")
async def get_room(room_id: str):
    """
    Get room state (destination, members, expiry).
    """
    try:
        room = room_service.get_room(room_id)
        if not room:
            raise HTTPException(status_code=404, detail="Room not found")
        
        # Check expiry
        if room_service.is_room_expired(room_id):
            raise HTTPException(status_code=410, detail="Room has expired")
        
        members_data = []
        for member in room.members.values():
            status = room_service.get_member_status(member.last_updated)
            members_data.append({
                "member_id": member.member_id,
                "name": member.name,
                "initials": member.name[0].upper() if member.name else "?",
                "last_location": {
                    "lat": member.last_location[0],
                    "lng": member.last_location[1]
                } if member.last_location else None,
                "last_updated": member.last_updated.isoformat() if member.last_updated else None,
                "status": status,
                "is_connected": member.is_connected
            })
        
        return {
            "room_id": room_id,
            "destination": {
                "name": room.destination_name,
                "lat": room.destination_lat,
                "lng": room.destination_lng
            },
            "members_count": len(room.members),
            "members": members_data,
            "expires_at": room.expires_at.isoformat(),
            "host_member_id": room.host_member_id
        }
    except HTTPException as e:
        raise
    except Exception as e:
        logger.error(f"Error getting room: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/rooms/{room_id}/end")
async def end_room(room_id: str, req: EndRoomRequest):
    """
    End a room (host only).
    """
    try:
        room = room_service.get_room(room_id)
        if not room:
            raise HTTPException(status_code=404, detail="Room not found")
        
        # Check if requester is host
        if room.host_member_id != req.member_id:
            raise HTTPException(status_code=403, detail="Only host can end room")
        
        # Verify token
        member = room.members.get(req.member_id)
        if not member or member.token != req.token:
            raise HTTPException(status_code=401, detail="Invalid token")
        
        # Broadcast room end to all connected members
        await connection_manager.broadcast_to_room(
            room_id=room_id,
            message=json.dumps({
                "type": "ended",
                "reason": "host_ended"
            })
        )
        
        # Remove room
        room_service.remove_room(room_id)
        
        logger.info(f"Room {room_id} ended by host {req.member_id}")
        
        return {"status": "Room ended"}
    except HTTPException as e:
        raise
    except Exception as e:
        logger.error(f"Error ending room: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============= WebSocket Endpoint =============

@app.websocket("/ws/rooms/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    """
    WebSocket endpoint for real-time location sharing.
    
    Query params: member_id, token
    """
    # Extract query params
    member_id = websocket.query_params.get("member_id")
    token = websocket.query_params.get("token")
    
    if not member_id or not token:
        await websocket.close(code=1008, reason="Missing member_id or token")
        return
    
    # Verify room exists and member is valid
    room = room_service.get_room(room_id)
    if not room:
        await websocket.close(code=1008, reason="Room not found")
        return
    
    member = room.members.get(member_id)
    if not member or member.token != token:
        await websocket.close(code=1008, reason="Invalid token")
        return
    
    # Accept connection
    await websocket.accept()
    await connection_manager.connect(room_id, member_id, websocket)
    
    logger.info(f"WebSocket connected: {member_id} in room {room_id}")
    
    # Mark member as connected
    member.is_connected = True
    
    # Broadcast initial state
    await broadcast_room_state(room_id)
    
    try:
        while True:
            # Receive message from client
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message.get("type") == "location":
                # Update member location
                lat = message.get("lat")
                lng = message.get("lng")
                
                if lat is not None and lng is not None:
                    member.last_location = (lat, lng)
                    member.last_updated = get_utc_now()
                    logger.debug(f"Location update: {member_id} -> ({lat}, {lng})")
            
            elif message.get("type") == "ping":
                # Keep-alive
                member.last_updated = get_utc_now()
            
            # Broadcast updated state to all in room
            await broadcast_room_state(room_id)
    
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {member_id}")
        member.is_connected = False
        connection_manager.disconnect(room_id, member_id)  # Synchronous method
        
        # Broadcast updated state
        await broadcast_room_state(room_id)
    
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        connection_manager.disconnect(room_id, member_id)  # Synchronous method

# ============= Helper Functions =============

async def broadcast_room_state(room_id: str):
    """
    Broadcast current room state to all connected members.
    """
    try:
        room = room_service.get_room(room_id)
        if not room:
            return
        
        # Check if room expired
        if room_service.is_room_expired(room_id):
            await connection_manager.broadcast_to_room(
                room_id=room_id,
                message=json.dumps({
                    "type": "ended",
                    "reason": "expired"
                })
            )
            room_service.remove_room(room_id)
            return
        
        # Build members state
        members_data = []
        for member in room.members.values():
            status = room_service.get_member_status(member.last_updated)
            members_data.append({
                "member_id": member.member_id,
                "name": member.name,
                "initials": member.name[0].upper() if member.name else "?",
                "last_location": {
                    "lat": member.last_location[0],
                    "lng": member.last_location[1]
                } if member.last_location else None,
                "last_updated_ago_secs": int((get_utc_now() - member.last_updated).total_seconds()) if member.last_updated else None,
                "status": status
            })
        
        state_message = {
            "type": "state",
            "room_id": room_id,
            "destination": {
                "name": room.destination_name,
                "lat": room.destination_lat,
                "lng": room.destination_lng
            },
            "expires_at": room.expires_at.isoformat(),
            "members": members_data
        }
        
        await connection_manager.broadcast_to_room(
            room_id=room_id,
            message=json.dumps(state_message)
        )
    
    except Exception as e:
        logger.error(f"Error broadcasting room state: {e}")

# ============= Startup/Shutdown =============

@app.on_event("startup")
async def startup_event():
    logger.info("Tether backend started")
    logger.info(f"CORS allowed origin: {FRONTEND_ORIGIN}")

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Tether backend shutting down")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
