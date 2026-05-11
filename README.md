# Exam Scanner Project

## Complete Tech Stack and Rationale

This project is a local-first exam scanning system. It combines a browser-based educator interface, a PHP/MySQL backend, a Python hardware scanner service, and Arduino firmware for paper feeding and paper-jam detection.

| Layer | Technologies Used | Where | Why They Were Chosen |
|---|---|---|---|
| Frontend application | React, Vite, JavaScript/JSX | `src/`, `index.html`, `vite.config.js` | React keeps the educator dashboard, login flow, answer-key setup, scan review, and state-heavy UI manageable. Vite gives fast local development and produces a static `dist/` build that Apache can serve under `/exam-scanner/dist/`. |
| Frontend styling | Tailwind CSS, PostCSS, Autoprefixer | `src/index.css`, `tailwind.config.js`, `postcss.config.js` | Tailwind supports quick, consistent interface styling without a separate design system. PostCSS and Autoprefixer keep the generated CSS browser-friendly. |
| Frontend document/data tools | `pdfjs-dist`, `xlsx` | `src/App.jsx`, `src/LmsDashboard.jsx` | `pdfjs-dist` lets the app read uploaded PDF exam files in the browser. `xlsx` supports spreadsheet import/export workflows for class and gradebook data. |
| Web server and local runtime | XAMPP, Apache, Windows | `C:\xampp\htdocs\exam-scanner`, `dist/` | XAMPP gives a simple Windows-friendly bundle for Apache, PHP, MySQL/MariaDB, and phpMyAdmin. Apache serves the built frontend and PHP API locally or over LAN/hotspot without needing cloud deployment. |
| Backend API | PHP REST-style endpoints, PDO | `backend/api/` | PHP fits naturally with XAMPP and Apache, requires little runtime setup on the target Windows PC, and can expose simple API endpoints for exams, submissions, accounts, scanner status, and grading. PDO provides safer database access through prepared statements and consistent error handling. |
| Database | MySQL/MariaDB | `backend/sql/schema.sql` | MySQL/MariaDB is included with XAMPP, easy to inspect with phpMyAdmin, and sufficient for storing educators, subjects, students, exams, answer keys, scan jobs, submissions, and grading records on one local machine. |
| Scanner service | Python 3, `ThreadingHTTPServer` | `scanner-service/main.py` | Python is better suited than PHP for direct hardware integration and image-processing workflows. The scanner service runs locally on `127.0.0.1:5001`, while the PHP backend proxies calls to it so remote devices only need to reach Apache. |
| OMR and image processing | OpenCV, NumPy, Pillow | `scanner-service/omr.py`, calibration and test scripts | OpenCV and NumPy provide the computer-vision operations needed for bubble detection, template alignment, thresholding, perspective correction, and diagnostic images. Pillow handles image loading/conversion around scanner output. |
| Scanner hardware access | Windows WIA through `pywin32` | `scanner-service/main.py` | WIA gives the Python service direct access to the Windows-connected document scanner, currently modeled around the Epson ES-50 workflow. |
| Arduino and feeder control | Arduino C/C++, serial protocol, `pyserial` | `Arduino Codes/motor-and-paper-jam-sensor/...`, `scanner-service/main.py` | The Arduino handles low-level motor timing and paper-jam sensing close to the hardware. Python talks to it over serial so the batch scan loop can feed sheets, stop on jams, and report feeder status. |
| Testing and diagnostics | Python `unittest`, OMR replay/calibration scripts, ESLint | `scanner-service/test_*.py`, `scanner-service/replay_omr.py`, `scanner-service/calibrate_template.py`, `eslint.config.js` | The scanner-side tests and replay tools make it possible to validate OMR behavior without constantly using the physical scanner. ESLint helps catch frontend code issues during development. |

The main architectural choice is to keep the system local. Exams, scans, and hardware control stay on the target PC, while phones or other devices can access the built web app through Apache on the same LAN or hotspot. This avoids cloud deployment complexity and keeps the scanner service private to the host machine.

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
