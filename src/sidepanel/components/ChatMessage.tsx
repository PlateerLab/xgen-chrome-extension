import type { ChatMessage as ChatMessageType } from '../../shared/types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallBadge } from './ToolCallBadge';

interface Props {
  message: ChatMessageType;
}

export function ChatMessage({ message }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2.5`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-relaxed ${
          isUser
            ? 'bg-gray-700 text-white'
            : isSystem
              ? 'bg-red-50 text-red-700 border border-red-100'
              : 'bg-gray-50 text-gray-800 border border-gray-100'
        }`}
      >
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {message.toolCalls.map((tc) => (
              <ToolCallBadge key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-sm prose-gray max-w-none
            prose-p:my-1 prose-li:my-0.5 prose-headings:mt-3 prose-headings:mb-1
            prose-pre:bg-gray-800 prose-pre:text-gray-100">
            <MarkdownRenderer content={message.content} />
          </div>
        )}

        {!isUser && message.tokenUsage && (
          <div className="text-[10px] text-gray-400 mt-1.5 pt-1 border-t border-gray-200/50 flex gap-2">
            <span>in: {message.tokenUsage.inputTokens.toLocaleString()}</span>
            <span>out: {message.tokenUsage.outputTokens.toLocaleString()}</span>
            <span>total: {message.tokenUsage.totalTokens.toLocaleString()}</span>
          </div>
        )}
      </div>
    </div>
  );
}
