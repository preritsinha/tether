#!/bin/bash

# Waysera startup script
# Launches the relay and the web client in separate terminal windows

set -e

echo "Starting Waysera..."

# Get the absolute path to the project directory
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    echo "Detected macOS"
    
    # Start backend in new Terminal window
    osascript -e "tell application \"Terminal\"
        do script \"cd '$PROJECT_DIR/backend' && echo 'Starting relay...' && uvicorn main:app --reload --host 0.0.0.0 --port 8000\"
        activate
    end tell"
    
    # Wait a moment for backend to start
    sleep 2
    
    # Start frontend in new Terminal window
    osascript -e "tell application \"Terminal\"
        do script \"cd '$PROJECT_DIR/web' && echo 'Starting web client...' && python3 -m http.server 3000\"
        activate
    end tell"
    
    echo "Relay and web client started in separate Terminal windows"
    echo ""
    echo "Relay: http://localhost:8000"
    echo "Web:   http://localhost:3000"
    echo ""
    echo "To stop: close the terminal windows, or run ./stop.sh"

elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    echo "Detected Linux"
    
    # Try different terminal emulators
    if command -v gnome-terminal &> /dev/null; then
        # GNOME Terminal
        gnome-terminal --tab --title="Waysera relay" -- bash -c "cd '$PROJECT_DIR/backend' && source .venv/bin/activate && echo 'Starting relay...' && uvicorn main:app --reload --host 0.0.0.0 --port 8000; exec bash"
        gnome-terminal --tab --title="Waysera web" -- bash -c "cd '$PROJECT_DIR/web' && echo 'Starting web client...' && python3 -m http.server 3000; exec bash"
    elif command -v xterm &> /dev/null; then
        # xterm
        xterm -hold -e "cd '$PROJECT_DIR/backend' && source .venv/bin/activate && echo 'Starting relay...' && uvicorn main:app --reload --host 0.0.0.0 --port 8000" &
        xterm -hold -e "cd '$PROJECT_DIR/web' && echo 'Starting web client...' && python3 -m http.server 3000" &
    elif command -v konsole &> /dev/null; then
        # KDE Konsole
        konsole --new-tab -e bash -c "cd '$PROJECT_DIR/backend' && source .venv/bin/activate && echo 'Starting relay...' && uvicorn main:app --reload --host 0.0.0.0 --port 8000; exec bash" &
        konsole --new-tab -e bash -c "cd '$PROJECT_DIR/web' && echo 'Starting web client...' && python3 -m http.server 3000; exec bash" &
    else
        echo "No supported terminal emulator found"
        echo ""
        echo "Please run manually:"
        echo "  Terminal 1: cd backend && source .venv/bin/activate && uvicorn main:app --reload --port 8000"
        echo "  Terminal 2: cd web && python3 -m http.server 3000"
        exit 1
    fi
    
    echo "Relay and web client started in separate terminal windows"
    echo ""
    echo "Relay: http://localhost:8000"
    echo "Web:   http://localhost:3000"
    echo ""
    echo "To stop: close the terminal windows, or run ./stop.sh"

else
    echo "Unsupported OS: $OSTYPE"
    echo ""
    echo "Manual startup:"
    echo "  Terminal 1: cd backend && source .venv/bin/activate && uvicorn main:app --reload --port 8000"
    echo "  Terminal 2: cd web && python3 -m http.server 3000"
    exit 1
fi

echo ""
echo "Waysera is running."
echo "   Open http://localhost:3000 in your browser"


