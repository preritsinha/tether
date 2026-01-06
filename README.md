# Tether - Real-time Location Sharing 🚀

url - https://tether-map.onrender.com

Ever tried coordinating with friends when everyone's driving to the same place? Too many "where are you?" texts, everyone's late, and nobody knows who's actually close.

**Tether fixes that.** Drop a pin, share a link, and everyone can see each other on a live map. Simple as that.

**Live Demo:** Coming soon (deploy to your own Render.com instance)

---

## ✨ Features

### Core Functionality
- 📍 **Real-time tracking** - See up to 10 people on a live map
- 🔗 **No signup needed** - Create a room and share the link
- ⏰ **Auto-expiring rooms** - Rooms close after 3 hours automatically
- 📱 **Mobile-optimized** - Built for phones and driving scenarios
- 🎭 **Demo mode** - Test without location access

### Navigation
- 🧭 **Turn-by-turn navigation** - Full-screen professional nav mode
- 🛣️ **Lane guidance** - See which lane to use before turns
- 📍 **Animated markers** - Pulsing location indicator with heading
- 🔄 **Auto-rerouting** - Recalculates if you go off course
- 🏁 **Arrival detection** - Celebration notification when you arrive
- ⚡ **60fps animations** - Buttery smooth on all devices

### Maps & UI
- 🗺️ **Mapbox integration** - High-quality professional street maps
- 🎨 **Modern design** - Sleek dark theme with glassmorphic UI
- 📊 **Live stats** - Distance, ETA, speed tracking
- 🌓 **Dark mode** - Follows system preference

---

## 🚀 Quick Start

### Using the Start Script (Easiest)

```bash
./start.sh
```

This automatically opens backend and frontend in separate terminals.

### Manual Setup

**Backend:**
```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

**Frontend** (separate terminal):
```bash
cd web
python -m http.server 3000
```

Open: `http://localhost:3000`

### 📱 Testing on Mobile

1. Get your computer's IP: `ifconfig` (Mac/Linux) or `ipconfig` (Windows)
2. Start backend with `--host 0.0.0.0`
3. On your phone, visit: `http://YOUR_IP:3000`
4. Make sure phone and computer are on the same WiFi

**Note:** Mobile browsers require HTTPS for geolocation. For local testing, use Safari on iOS or deploy to Render.com for automatic HTTPS.

---

## 🏗️ Project Structure

```
tether/
├── backend/              # FastAPI server
│   ├── main.py          # API routes + WebSocket
│   ├── services/        # Business logic
│   │   ├── room_service.py
│   │   ├── ws_manager.py
│   │   └── geo.py       # Distance calculations
│   ├── storage/         # In-memory data store
│   └── utils/           # Helpers
│
├── web/                 # Frontend (no build step!)
│   ├── index.html       # Main HTML
│   └── assets/
│       ├── app.js       # Config
│       ├── config.js    # Mapbox token
│       ├── index.js     # Main app logic
│       └── app-mobile.css  # Styles
│
├── start.sh             # Easy startup script
└── stop.sh              # Cleanup script
```

---

## 🎯 How to Use

### Create a Room
1. Open the app
2. Search for a destination (or enter coordinates)
3. Click "Create Room"
4. Share the room code or link

### Join a Room
1. Open the shared link or enter the room code
2. Enter your name
3. Allow location permission
4. You'll see everyone on the map!

### Start Navigation
1. Click **"🧭 Start Navigation"**
2. Full-screen navigation mode activates
3. Follow turn-by-turn directions
4. Tap "X" to exit navigation

**Testing Tip:** Open 2-3 incognito windows, join the same room with different names, and enable demo mode to see simulated movement.

---

## ⚙️ Configuration

### Frontend (`web/assets/config.js`)

```javascript
const TETHER_CONFIG = {
    MAPBOX_TOKEN: 'your_mapbox_token_here',
    USE_MAPBOX_ON_LOCALHOST: false
};
```

### Backend (`.env` file)

```bash
FRONTEND_ORIGIN=http://localhost:3000
ROOM_TTL_SECONDS=10800  # 3 hours
```

### Mapbox Setup

1. Get a token at: https://account.mapbox.com/access-tokens/
2. Add to `web/assets/config.js`
3. Set URL restrictions:
   - `https://your-domain.com/*`
   - `http://localhost:*` (for local testing)

---

## 🌐 API Reference

### Create Room
```http
POST /rooms
Content-Type: application/json

{
  "destination_name": "Central Park",
  "destination_lat": 40.7829,
  "destination_lng": -73.9654,
  "duration_minutes": 180
}
```

### Join Room
```http
POST /rooms/{room_id}/join

{"name": "Alice"}
```

### Get Room State
```http
GET /rooms/{room_id}
```

### End Room
```http
POST /rooms/{room_id}/end
```

### WebSocket
```
WS /ws/rooms/{room_id}?token={member_token}
```

Clients send location updates every 3 seconds. Server broadcasts updates every second.

---

## 🚢 Deploying to Render

### Backend (Web Service)
1. Create new **Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Root Directory:** `backend`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port 10000`
4. Environment Variables:
   - `FRONTEND_ORIGIN=https://your-frontend-url.onrender.com`
5. Deploy

### Frontend (Static Site)
1. Create new **Static Site**
2. Connect your GitHub repo
3. Settings:
   - **Root Directory:** `web`
   - **Publish Directory:** `.`
4. Update `web/assets/app.js`:
   ```javascript
   API_BASE: 'https://your-backend-url.onrender.com'
   ```
5. Deploy

**Both services work on Render's free tier!**

---

## 🛠️ Tech Stack

- **Backend:** FastAPI, Python 3.9+, WebSockets, Uvicorn
- **Frontend:** Vanilla JavaScript (no framework!)
- **Maps:** Leaflet.js + Mapbox tiles
- **Routing:** Leaflet Routing Machine + OSRM
- **Storage:** In-memory (for MVP)
- **Deployment:** Render.com

### Why These Choices?

- **FastAPI** - Built-in WebSocket support, fast, easy to deploy
- **Vanilla JS** - No build step, works everywhere, lightweight
- **Leaflet** - Powerful, flexible, open-source
- **Mapbox** - Professional quality maps, generous free tier
- **In-memory** - Simple for MVP, easy to replace with Redis/Postgres later

---

## 🐛 Troubleshooting

### Backend won't connect
- Check `API_BASE` in `app.js` matches your backend URL
- Verify CORS settings in `backend/main.py`
- Check backend logs: `docker logs` or Render dashboard

### WebSocket errors
- Production must use `wss://` not `ws://`
- Render handles this automatically
- Check browser console (F12) for errors

### Location permission denied
- **Mobile browsers require HTTPS** for geolocation
- Local testing: Use Safari on iOS
- Or deploy to Render.com for automatic HTTPS

### Map tiles not loading
- Check Mapbox token is valid
- Verify URL restrictions on mapbox.com
- Check browser network tab for 401/403 errors

### Rooms disappearing
- Rooms are stored in memory
- Server restart = rooms gone
- This is by design for MVP
- Add Redis/Postgres for persistence

### Navigation not working
- Check routing service is accessible
- Currently using: `routing.openstreetmap.de`
- Browser console shows routing errors
- Fallback: Shows direct route line if service is down

---

## 🔒 Security

This is an MVP with basic security:

✅ **Included:**
- Random tokens for each user
- 6-character room codes
- CORS validation
- Token-based WebSocket auth
- URL restrictions on Mapbox token

❌ **Not Included (for production):**
- User authentication / OAuth
- Rate limiting
- Encryption at rest
- Database persistence
- Audit logging
- Input sanitization beyond basics

**Don't use this for sensitive data.** It's meant for casual friend tracking, not military ops.

For production, add:
1. Proper authentication (OAuth2, JWT)
2. Rate limiting (Redis + middleware)
3. Database encryption
4. HTTPS everywhere
5. Security headers
6. Input validation library

---

## 🚀 What's Next?

To productionize this:

1. **Persistence:** Replace in-memory with Postgres/Redis
2. **Auth:** Add proper user accounts with OAuth
3. **Mobile App:** React Native version
4. **Offline Mode:** Cache maps and work offline
5. **Analytics:** Track usage, routes, popular destinations
6. **Notifications:** Push notifications for arrivals
7. **History:** Save past trips and routes
8. **Groups:** Support for larger groups (>10 people)
9. **Privacy:** Fine-grained location sharing controls
10. **Monetization:** Premium features, remove ads

---

## 📄 License

MIT License - Do whatever you want with it!

---

## 💬 Questions?

- Check browser console (F12) - detailed logs everywhere
- Check backend logs - verbose error messages
- Open an issue on GitHub

---

**Built with ❤️ for people who are tired of "where are you?" texts**
