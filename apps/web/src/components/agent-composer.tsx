'use client';

import { ArrowUp, AtSign, Paperclip, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';

export function AgentComposer(): React.JSX.Element {
  const [message, setMessage] = useState('');

  return (
    <form
      className="agent-composer"
      onSubmit={(event) => {
        event.preventDefault();
        setMessage('');
      }}
    >
      <textarea
        aria-label="发送消息给 Agent"
        onChange={(event) => {
          setMessage(event.target.value);
        }}
        placeholder="向 Agent 发送消息..."
        rows={3}
        value={message}
      />
      <div className="composer-actions">
        <div>
          <button aria-label="添加附件" className="icon-button" title="添加附件" type="button">
            <Paperclip aria-hidden="true" size={17} />
          </button>
          <button aria-label="添加 Mention" className="icon-button" title="Mention" type="button">
            <AtSign aria-hidden="true" size={17} />
          </button>
          <button aria-label="运行设置" className="icon-button" title="运行设置" type="button">
            <SlidersHorizontal aria-hidden="true" size={17} />
          </button>
        </div>
        <button
          aria-label="发送"
          className="send-button"
          disabled={message.trim().length === 0}
          title="发送"
          type="submit"
        >
          <ArrowUp aria-hidden="true" size={17} />
        </button>
      </div>
    </form>
  );
}
