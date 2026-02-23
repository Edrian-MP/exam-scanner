# Windows 11 Deployment Guide (Target PC)

## 1) Compatibility Check for Your Hardware
Target specs:
- Motherboard: Foxconn H61 (LGA1155)
- CPU: Intel Core i5-3470
- RAM: 16 GB DDR3 (2x8 GB Kingston HyperX 1600)
- Storage: WD 256 GB SATA SSD

### Verdict
- This project itself is compatible with those specs for local use.
- The stack (React/Vite + PHP + MySQL + Python service) is lightweight enough for i5-3470 + 16 GB RAM.
- SSD is sufficient for OS, app, and database.

### Important Windows 11 Note
- Intel i5-3470 is not on Microsoft's officially supported Windows 11 CPU list.
- Many H61 boards also lack TPM 2.0/Secure Boot requirements.
- If Windows 11 is already installed and stable on that PC, this app can still run.

## 2) Required Software on the Target PC
Install these first:
1. XAMPP (Apache + MySQL + phpMyAdmin), PHP 8.x build recommended.
2. Node.js LTS (20+ recommended).
3. Python 3.11+ (3.12 recommended), and enable "Add Python to PATH".
4. Git (optional, only if cloning from repository).

## 3) Copy Project to Target PC
Use one method:
1. Copy the project folder directly (USB/LAN) to:
   `C:\xampp\htdocs\exam-scanner`
2. Or clone with Git into:
   `C:\xampp\htdocs\exam-scanner`

## 4) Backend Setup (PHP + MySQL)
1. Open XAMPP Control Panel.
2. Start `Apache` and `MySQL`.
3. Open `http://localhost/phpmyadmin`.
4. Import database schema:
   - Choose `Import`
   - Select file: `C:\xampp\htdocs\exam-scanner\backend\sql\schema.sql`
   - Run import
5. Check API health:
   `http://localhost/exam-scanner/backend/api/health`

## 5) Frontend Setup (React)
Open PowerShell in `C:\xampp\htdocs\exam-scanner` and run:

```powershell
npm install
```

Create `.env` in project root with:

```env
VITE_API_BASE_URL=http://localhost/exam-scanner/backend/api
```

Start frontend:

```powershell
npm run dev
```

Default URL:
`http://localhost:5173`

## 6) Scanner Service Setup (Python)
Open another PowerShell window in `C:\xampp\htdocs\exam-scanner` and run:

```powershell
python -m pip install pyserial
python scanner-service/main.py
```

Check service status:
`http://127.0.0.1:5001/status`

## 7) Verify Full Flow
1. Backend health: `http://localhost/exam-scanner/backend/api/health`
2. Scanner status endpoint: `http://127.0.0.1:5001/status`
3. Frontend opens: `http://localhost:5173`
4. In app, create exam and run scan action.

## 8) Runtime Start Order (Every Reboot)
1. Start XAMPP: Apache + MySQL
2. Start scanner service:
   `python scanner-service/main.py`
3. Start frontend:
   `npm run dev`

## 9) Troubleshooting
- `Port 5173 busy`: run `npm run dev -- --port 5174` and update CORS/API config if needed.
- `API DB connection failed`: verify MySQL running and schema imported.
- `CORS errors`: ensure frontend URL matches `cors_origin` in `backend/api/config.php` (or env var).
- `Scanner offline`: confirm Python service is running on port 5001.

## 10) Optional Production Hardening
- Build frontend with `npm run build`.
- Serve static `dist/` via Apache instead of Vite dev server.
- Set backend env vars (`DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`, `SCANNER_SERVICE_URL`, `CORS_ORIGIN`) in Apache/OS environment.

test
