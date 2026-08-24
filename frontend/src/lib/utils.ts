import type { ClassValue } from 'clsx'
import clsx from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatNumber(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return '-'
  const num = Number(n)
  if (Number.isNaN(num)) return '-'
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '--'
  const normalized = iso.includes(' ') ? `${iso.replace(' ', 'T')}Z` : iso
  const d = new Date(normalized)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatPercent(price: number | null | undefined): string {
  if (price === null || price === undefined || Number.isNaN(price)) return '--'
  return `${(price * 100).toFixed(1)}%`
}

export function formatUsdc(amount: number | string | null | undefined, decimals = 2): string {
  if (amount === null || amount === undefined) return '0.00'
  const num = Number(amount)
  if (Number.isNaN(num)) return '0.00'
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

export function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num))
}

export function escapeHtml(str: unknown): string {
  return String(str ?? '').replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return map[c] ?? c
  })
}
