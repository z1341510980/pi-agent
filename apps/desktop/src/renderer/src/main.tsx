import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './assets/main.css'

import App from './App'

const rootElement = document.getElementById('app')

if (!rootElement) {
  throw new Error('Missing renderer root element')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
