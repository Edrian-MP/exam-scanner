import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { OSKProvider } from './hooks/useOSK.jsx'
import OnScreenKeyboard from './OnScreenKeyboard.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <OSKProvider>
      <App />
      <OnScreenKeyboard />
    </OSKProvider>
  </StrictMode>,
)
