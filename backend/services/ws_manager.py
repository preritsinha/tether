from typing import Dict, Set
from fastapi import WebSocket
import json

class ConnectionManager:
    """
    Manages WebSocket connections per room.
    
    Structure is simple: {room_id: {member_id: websocket}}
    When someone connects, add them. When they disconnect, remove them.
    """
    
    def __init__(self):
        self.active_connections: Dict[str, Dict[str, WebSocket]] = {}
        # Structure: {room_id: {member_id: websocket}}
    
    async def connect(self, room_id: str, member_id: str, websocket: WebSocket):
        """Register a new connection"""
        if room_id not in self.active_connections:
            self.active_connections[room_id] = {}
        
        self.active_connections[room_id][member_id] = websocket
    
    def disconnect(self, room_id: str, member_id: str):
        """Remove a connection"""
        if room_id in self.active_connections:
            if member_id in self.active_connections[room_id]:
                del self.active_connections[room_id][member_id]
            
            # Clean up empty rooms
            if not self.active_connections[room_id]:
                del self.active_connections[room_id]
    
    async def broadcast_to_room(self, room_id: str, message: str):
        """Send message to all members in a room"""
        if room_id not in self.active_connections:
            return
        
        # Create list of disconnected members to remove
        disconnected = []
        
        for member_id, websocket in self.active_connections[room_id].items():
            try:
                await websocket.send_text(message)
            except Exception as e:
                disconnected.append(member_id)
        
        # Remove disconnected members
        for member_id in disconnected:
            self.disconnect(room_id, member_id)
