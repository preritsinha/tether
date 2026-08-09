#!/bin/bash

# Waysera stop script
# Kills any processes running on ports 8000 and 3000

echo "Stopping Waysera..."

# Relay
BACKEND_PROC=$(lsof -ti:8000 2>/dev/null)
if [ ! -z "$BACKEND_PROC" ]; then
    kill $BACKEND_PROC 2>/dev/null
    echo "Stopped the relay on port 8000."
else
    echo "Nothing running on port 8000."
fi

# Web client
FRONTEND_PROC=$(lsof -ti:3000 2>/dev/null)
if [ ! -z "$FRONTEND_PROC" ]; then
    kill $FRONTEND_PROC 2>/dev/null
    echo "Stopped the web client on port 3000."
else
    echo "Nothing running on port 3000."
fi

echo ""
echo "Waysera stopped."


