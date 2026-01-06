#!/bin/bash

# Tether Stop Script
# Kills any processes running on ports 8000 and 3000

echo "🛑 Stopping Tether..."

# Kill any process using port 8000 (backend)
BACKEND_PROC=$(lsof -ti:8000 2>/dev/null)
if [ ! -z "$BACKEND_PROC" ]; then
    kill $BACKEND_PROC 2>/dev/null
    echo "✅ Killed process on port 8000 (backend)"
else
    echo "⚠️  No process found on port 8000"
fi

# Kill any process using port 3000 (frontend)
FRONTEND_PROC=$(lsof -ti:3000 2>/dev/null)
if [ ! -z "$FRONTEND_PROC" ]; then
    kill $FRONTEND_PROC 2>/dev/null
    echo "✅ Killed process on port 3000 (frontend)"
else
    echo "⚠️  No process found on port 3000"
fi

echo ""
echo "✅ Tether stopped"


