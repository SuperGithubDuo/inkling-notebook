import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { useStore } from './store/store'

window.inkling.onFlushRequest(() => useStore.getState().flush())

if (window.inkling.testHooks) {
  // Lets acceptance tests drive the assistant API the future AI Tutor will use.
  void import('./services/notebookContext').then(({ notebookContext }) => {
    ;(window as unknown as { __inkling: unknown }).__inkling = { notebookContext }
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
