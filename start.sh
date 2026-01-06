#!/bin/bash

# Tether Startup Script
# Launches backend and frontend in separate terminal windows

set -e

echo "🚀 Starting Tether..."

# Get the absolute path to the project directory
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    echo "📱 Detected macOS"
    
    # Start backend in new Terminal window
    osascript -e "tell application \"Terminal\"
        do script \"cd '$PROJECT_DIR/backend' && echo '🔧 Starting backend...' && uvicorn main:app --reload --host 0.0.0.0 --port 8000\"
        activate
    end tell"
    
    # Wait a moment for backend to start
    sleep 2
    
    # Start frontend in new Terminal window
    osascript -e "tell application \"Terminal\"
        do script \"cd '$PROJECT_DIR/web' && echo '🌐 Starting frontend...' && python3 -m http.server 3000\"
        activate
    end tell"
    
    echo "✅ Backend and frontend started in separate Terminal windows"
    echo ""
    echo "📍 Backend:  http://localhost:8000"
    echo "📍 Frontend: http://localhost:3000"
    echo ""
    echo "💡 To stop: Close the terminal windows or press Ctrl+C in each"

elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    echo "🐧 Detected Linux"
    
    # Try different terminal emulators
    if command -v gnome-terminal &> /dev/null; then
        # GNOME Terminal
        gnome-terminal --tab --title="Tether Backend" -- bash -c "cd '$PROJECT_DIR/backend' && source venv/bin/activate && echo '🔧 Starting backend...' && uvicorn main:app --reload --host 0.0.0.0 --port 8000; exec bash"
        gnome-terminal --tab --title="Tether Frontend" -- bash -c "cd '$PROJECT_DIR/web' && echo '🌐 Starting frontend...' && python3 -m http.server 3000; exec bash"
    elif command -v xterm &> /dev/null; then
        # xterm
        xterm -hold -e "cd '$PROJECT_DIR/backend' && source venv/bin/activate && echo '🔧 Starting backend...' && uvicorn main:app --reload --host 0.0.0.0 --port 8000" &
        xterm -hold -e "cd '$PROJECT_DIR/web' && echo '🌐 Starting frontend...' && python3 -m http.server 3000" &
    elif command -v konsole &> /dev/null; then
        # KDE Konsole
        konsole --new-tab -e bash -c "cd '$PROJECT_DIR/backend' && source venv/bin/activate && echo '🔧 Starting backend...' && uvicorn main:app --reload --host 0.0.0.0 --port 8000; exec bash" &
        konsole --new-tab -e bash -c "cd '$PROJECT_DIR/web' && echo '🌐 Starting frontend...' && python3 -m http.server 3000; exec bash" &
    else
        echo "❌ No supported terminal emulator found"
        echo ""
        echo "Please run manually:"
        echo "  Terminal 1: cd backend && source venv/bin/activate && uvicorn main:app --reload --port 8000"
        echo "  Terminal 2: cd web && python3 -m http.server 3000"
        exit 1
    fi
    
    echo "✅ Backend and frontend started in separate terminal windows"
    echo ""
    echo "📍 Backend:  http://localhost:8000"
    echo "📍 Frontend: http://localhost:3000"
    echo ""
    echo "💡 To stop: Close the terminal windows or press Ctrl+C in each"

else
    echo "❌ Unsupported OS: $OSTYPE"
    echo ""
    echo "Manual startup:"
    echo "  Terminal 1: cd backend && source venv/bin/activate && uvicorn main:app --reload --port 8000"
    echo "  Terminal 2: cd web && python3 -m http.server 3000"
    exit 1
fi

echo ""
echo "🎉 Tether is running!"
echo "   Open http://localhost:3000 in your browser"


