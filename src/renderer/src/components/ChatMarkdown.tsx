import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Props = {
  markdown: string
  className?: string
  /** Streaming: keep monospace-ish feel for incomplete fences. */
  streaming?: boolean
}

/**
 * Cursor-like chat prose: GFM markdown without the ops-card chrome.
 * Fenced code stays readable; links open externally.
 */
export default function ChatMarkdown({ markdown, className, streaming }: Props): ReactNode {
  const src = String(markdown ?? '')
  if (!src.trim()) return null
  return (
    <div
      className={`ai-chat-md${streaming ? ' is-streaming' : ''}${className ? ` ${className}` : ''}`}
      data-testid="ai-chat-md"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => (
            <a href={href} target="_blank" rel="noreferrer" {...props}>
              {children}
            </a>
          ),
          table: ({ children, ...props }) => (
            <div className="ai-chat-md-table">
              <table {...props}>{children}</table>
            </div>
          ),
          pre: ({ children, ...props }) => (
            <pre className="ai-chat-md-pre" {...props}>
              {children}
            </pre>
          ),
          code: ({ className: cn, children, ...props }) => {
            const inline = !cn
            if (inline) {
              return (
                <code className="ai-inline-code" {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className={cn} {...props}>
                {children}
              </code>
            )
          }
        }}
      >
        {src}
      </ReactMarkdown>
    </div>
  )
}
