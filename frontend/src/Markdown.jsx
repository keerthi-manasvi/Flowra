import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import 'highlight.js/styles/github-dark.css';

function Pre({ children }) {
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);
  const lang = /language-([\w+#-]+)/.exec(children?.props?.className || '')?.[1] || 'text';
  const copy = () =>
    navigator.clipboard.writeText(ref.current.innerText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  return (
    <div className="code">
      <div className="code-bar">
        <span>{lang}</span>
        <button type="button" className="nodrag nopan" onClick={copy}>{copied ? 'Copied ✓' : 'Copy code'}</button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

const remark = [remarkGfm];
// Include rehypeRaw and rehypeSanitize alongside rehypeHighlight
const rehype = [rehypeRaw, rehypeSanitize, rehypeHighlight];
const components = { pre: Pre };

// compact = canvas card: plain Markdown, no highlighter or code header.
export default function Markdown({ children, compact }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={remark}
        rehypePlugins={compact ? [rehypeRaw, rehypeSanitize] : rehype}
        components={compact ? undefined : components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}