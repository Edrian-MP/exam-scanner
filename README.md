# Exam Scanner Project

## Stack
- Frontend: React + Tailwind (`src/`)
- API backend: PHP REST (`backend/api/`)
- Database: MySQL schema (`backend/sql/schema.sql`)
- Scanner service: Python local service (`scanner-service/main.py`)

## Frontend (React)
1. Install deps: `npm install`
2. Dev server: `npm run dev`
3. Optional API base override: create `.env` with
   `VITE_API_BASE_URL=http://localhost/exam-scanner/backend/api`

## Backend (PHP + Apache + MySQL)
1. Copy this repo into `C:\xampp\htdocs\exam-scanner`
2. Import `backend/sql/schema.sql` in phpMyAdmin
3. Open API health check:
   `http://localhost/exam-scanner/backend/api/health`
4. Set env vars in Apache or adapt `backend/api/config.php`

## Scanner Service (Python)
1. Run: `python scanner-service/main.py`
2. Status endpoint: `http://127.0.0.1:5001/status`

## API endpoints
- `GET /health`
- `GET /scanner/status`
- `POST /scanner/scan` with `{ "exam_id": 1 }`
- `GET /exams`
- `POST /exams`
- `POST /grade/submit`

## Network Access (LAN / Hotspot)

The built app is served by Apache and reachable from any device on the same network.

| Context | URL |
|---|---|
| Host PC (localhost) | `http://localhost/exam-scanner/dist/` |
| LAN (host PC's IP) | `http://<TPC-IP>/exam-scanner/dist/` |
| PC hotspot (default) | `http://192.168.137.1/exam-scanner/dist/` |

**Start order:**
1. XAMPP → Apache + MySQL
2. `python scanner-service/main.py`
3. `npm run build` (then Apache serves `dist/`)  
   *or* `npm run dev` for the live-reload dev server

**Firewall:** Windows Firewall must allow inbound connections on port 80 (Apache) from the target network. For the dev server on port 5173, allow that port too if testing dev mode from another device.

**Scanner service** stays on `127.0.0.1:5001` (host only). Remote devices reach it indirectly through the PHP backend proxy.

## Notes
- PHP API proxies scanner calls to Python service.
- CORS defaults to `http://localhost:5173` (dev proxy handles cross-origin in dev mode).
- Replace mock scan logic in `scanner-service/main.py` with actual WIA + pyserial flow.
