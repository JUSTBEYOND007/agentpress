import { DomainError } from './domain-error.js';

export function transitionState<State extends string>(
  aggregate: string,
  current: State,
  next: State,
  transitions: Readonly<Record<State, readonly State[]>>,
  terminalStates: ReadonlySet<State>,
): State {
  if (terminalStates.has(current)) {
    throw new DomainError('terminal_state', `${aggregate} terminal state is immutable`, {
      aggregate,
      current,
      next,
    });
  }

  if (!transitions[current].includes(next)) {
    throw new DomainError('invalid_transition', `Cannot transition ${aggregate} to ${next}`, {
      aggregate,
      current,
      next,
    });
  }

  return next;
}
