'use client';

import { useState } from 'react';

import { stringValue, type RunPart } from '../lib/agentpress-assistant-runtime';
import { useRunActions } from './agent-run-actions';
import { friendlyFailure } from './agent-view-model';

export function AskUserPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const actions = useRunActions();
  const [answer, setAnswer] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submittedAnswer, setSubmittedAnswer] = useState('');
  const [error, setError] = useState<string>();
  const options = Array.isArray(part.payload.options)
    ? part.payload.options.filter((value): value is string => typeof value === 'string')
    : [];
  const submit = (value: string): void => {
    if (!value.trim() || submitted) return;
    setSubmitted(true);
    setError(undefined);
    void actions
      .answerQuestion(part.runId, stringValue(part.payload.questionId), value)
      .then(() => {
        setSubmittedAnswer(value.trim());
      })
      .catch((reason: unknown) => {
        setSubmitted(false);
        setError(friendlyFailure(reason, '回答没有发送成功，请重试。'));
      });
  };
  return (
    <section className="run-part ask-user-part">
      <strong>{stringValue(part.payload.question) || '需要补充信息'}</strong>
      {submittedAnswer ? (
        <p className="interaction-result">已回答：{submittedAnswer}</p>
      ) : options.length > 0 ? (
        <div>
          {options.map((option) => (
            <button
              disabled={submitted}
              key={option}
              onClick={() => {
                submit(option);
              }}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {!submittedAnswer ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit(answer);
          }}
        >
          <input
            aria-label="回答 Agent 的问题"
            disabled={submitted}
            onChange={(event) => {
              setAnswer(event.target.value);
            }}
            value={answer}
          />
          <button disabled={submitted || !answer.trim()} type="submit">
            回答
          </button>
        </form>
      ) : null}
      {error ? <p className="interaction-error">{error}</p> : null}
    </section>
  );
}
