import { useEffect, useRef, useState } from 'react';
import { useChat } from './hooks/useChat';
import { ChatMessage } from './components/ChatMessage';
import { InputArea } from './components/InputArea';
import { SettingsBar } from './components/SettingsBar';
import { ApiMonitor } from './components/ApiMonitor';

type Tab = 'chat' | 'api';

export function App() {
  const { messages, isStreaming, sendMessage, clearMessages } = useChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<Tab>('chat');

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex flex-col h-screen bg-white text-gray-800">
      {/* Header */}
      <header className="flex items-center px-3 py-2 border-b border-gray-200">
        <h1 className="text-sm font-medium text-gray-700 tracking-tight mr-3">
          XGEN AI
        </h1>
        {/* Tabs */}
        <div className="flex gap-1 flex-1">
          <button
            onClick={() => setActiveTab('chat')}
            className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
              activeTab === 'chat'
                ? 'bg-gray-200 text-gray-700 font-medium'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            Chat
          </button>
          <button
            onClick={() => setActiveTab('api')}
            className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
              activeTab === 'api'
                ? 'bg-gray-200 text-gray-700 font-medium'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            API Hook
          </button>
        </div>
        {activeTab === 'chat' && (
          <button
            onClick={clearMessages}
            className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors"
            title="대화 초기화"
          >
            초기화
          </button>
        )}
      </header>

      {activeTab === 'chat' ? (
        <>
          {/* Settings */}
          <SettingsBar />

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-gray-300 text-sm gap-1">
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <span>메시지를 입력하세요</span>
              </div>
            )}

            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <InputArea onSend={sendMessage} disabled={isStreaming} />
        </>
      ) : (
        <ApiMonitor />
      )}
    </div>
  );
}
