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

/**
 * 时间戳统一按北京时间显示。
 *
 * 两点约定：
 *  1) 裸的 `YYYY-MM-DD HH:MM:SS`（MySQL dateStrings）按 UTC 解析——库内一律存 UTC。
 *  2) 显式指定 Asia/Shanghai，不跟随浏览器所在时区，
 *     否则同一条数据在不同机器上显示不同时间。
 */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '--'
  const normalized = iso.includes(' ') ? `${iso.replace(' ', 'T')}Z` : iso
  const d = new Date(normalized)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
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

/**
 * 成交额/流动性金额显示，带 $ 前缀并按 K/M 缩写。
 *
 * 缺数据返回 '—' 而不是 '$0'：盘口真的零成交，和接口没给这个字段，
 * 是两件不同的事，混在一起看不出来。
 */
export function formatVolume(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '—'
  const num = Number(n)
  if (!Number.isFinite(num)) return '—'
  return `$${formatNumber(num)}`
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
