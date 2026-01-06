import random
import string
import uuid

def generate_room_id(length: int = 6) -> str:
    """Generate a short, human-friendly room ID (like ABC123)"""
    chars = string.ascii_uppercase + string.digits
    return ''.join(random.choice(chars) for _ in range(length))

def generate_member_id() -> str:
    """Generate a unique member ID (m_xxxxxxxxxxxx)"""
    return f"m_{uuid.uuid4().hex[:12]}"

def generate_token(length: int = 32) -> str:
    """Generate a random token for WebSocket auth. Not cryptographic, but good enough."""
    chars = string.ascii_letters + string.digits
    return ''.join(random.choice(chars) for _ in range(length))
