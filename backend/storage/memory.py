from typing import Dict, List, Optional
from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class Member:
    member_id: str
    name: str
    token: str
    last_location: Optional[tuple] = None  # (lat, lng)
    last_updated: Optional[datetime] = None
    is_connected: bool = False

@dataclass
class Room:
    room_id: str
    destination_name: str
    destination_lat: float
    destination_lng: float
    created_at: datetime
    expires_at: datetime
    host_member_id: Optional[str] = None
    members: Dict[str, Member] = field(default_factory=dict)

class MemoryStore:
    """
    In-memory storage for rooms and members.
    
    Yeah, I know - everything disappears when the server restarts.
    That's intentional for the MVP. Add Postgres or Redis later if needed.
    """
    
    def __init__(self):
        self.rooms: Dict[str, Room] = {}
    
    def create_room(self, room: Room):
        self.rooms[room.room_id] = room
    
    def get_room(self, room_id: str) -> Optional[Room]:
        return self.rooms.get(room_id)
    
    def remove_room(self, room_id: str):
        if room_id in self.rooms:
            del self.rooms[room_id]
    
    def add_member(self, room_id: str, member: Member):
        room = self.get_room(room_id)
        if room:
            room.members[member.member_id] = member
    
    def remove_member(self, room_id: str, member_id: str):
        room = self.get_room(room_id)
        if room and member_id in room.members:
            del room.members[member_id]
    
    def get_member(self, room_id: str, member_id: str) -> Optional[Member]:
        room = self.get_room(room_id)
        if room:
            return room.members.get(member_id)
        return None
