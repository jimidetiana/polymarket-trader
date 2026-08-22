import { Component, type ReactNode } from 'react'

interface Props {
  children?: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.warn('SDK component render error:', error)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground">
          SDK 组件渲染失败，已切换为原生实现。
        </div>
      )
    }
    return this.props.children
  }
}
