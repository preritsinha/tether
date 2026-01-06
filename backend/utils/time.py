from datetime import datetime, timezone

def get_utc_now() -> datetime:
    """Get current UTC timestamp with timezone info"""
    return datetime.now(timezone.utc)
