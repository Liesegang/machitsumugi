import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  return <dialog ref={ref} onCancel={e => { e.preventDefault(); onClose() }} onClick={e => { if (e.target === ref.current) { const rect = ref.current.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose() } }}><div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="閉じる" onClick={onClose}><X size={20} /></button></div>{children}</dialog>
}
