from datetime import datetime, timedelta
from typing import Optional
from storage.memory import Room, Member, MemoryStore
from utils.time import get_utc_now

class RoomService:
    """
    Manages room and member lifecycle.
    
    Basically CRUD operations + some helper methods for checking
    if stuff is expired and calculating member status.
    """
    
    def __init__(self, store: MemoryStore, ttl_seconds: int = 10800):
        self.store = store
        self.ttl_seconds = ttl_seconds
    
    def create_room(self, room_id: str, destination_name: str, destination_lat: float, 
                    destination_lng: float, duration_minutes: Optional[int] = None) -> Room:
        """Create a new room"""
        if duration_minutes is None:
            duration_minutes = 180  # 3 hours default
        
        now = get_utc_now()
        expires_at = now + timedelta(minutes=duration_minutes)
        
        room = Room(
            room_id=room_id,
            destination_name=destination_name,
            destination_lat=destination_lat,
            destination_lng=destination_lng,
            created_at=now,
            expires_at=expires_at
        )
        
        self.store.create_room(room)
        return room
    
    def get_room(self, room_id: str) -> Optional[Room]:
        """Get room by ID"""
        return self.store.get_room(room_id)
    
    def remove_room(self, room_id: str):
        """Remove room"""
        self.store.remove_room(room_id)
    
    def is_room_expired(self, room_id: str) -> bool:
        """Check if room has expired"""
        room = self.store.get_room(room_id)
        if not room:
            return True
        return get_utc_now() > room.expires_at
    
    def add_member(self, room_id: str, member_id: str, name: str, token: str):
        """Add member to room"""
        member = Member(
            member_id=member_id,
            name=name,
            token=token,
            last_updated=get_utc_now()
        )
        self.store.add_member(room_id, member)
    
    def remove_member(self, room_id: str, member_id: str):
        """Remove member from room"""
        self.store.remove_member(room_id, member_id)
    
    def get_member_status(self, last_updated: Optional[datetime]) -> str:
        """Get member status based on last update time"""
        if not last_updated:
            return "Offline"
        
        elapsed = (get_utc_now() - last_updated).total_seconds()
        
        if elapsed <= 10:
            return "Live"
        elif elapsed <= 30:
            return "Stale"
        else:
            return "Offline"
