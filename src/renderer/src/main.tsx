import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { useStore } from './store/store'

window.inkling.onFlushRequest(() => useStore.getState().flush())

if (window.inkling.testHooks) {
  // Lets acceptance tests drive the assistant API the future AI Tutor will use.
  void Promise.all([import('./services/notebookContext'), import('./phonepad/install')]).then(([{ notebookContext }, { phonePadForTests }]) => {
    // PhonePad's writing area, so tests can check where phone ink lands.
    const phonepad = { area: () => phonePadForTests()?.area ?? null }
    ;(window as unknown as { __inkling: unknown }).__inkling = { notebookContext, phonepad }
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
