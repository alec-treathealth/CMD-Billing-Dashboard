'use client';

/**
 * Client shell for the v3 flow. It exists for exactly one reason: to hold the action state so the
 * typed term travels in a POST body instead of a query string.
 *
 * The term lives in this component's `useActionState` result and in the uncontrolled input's DOM
 * value — never lifted, never persisted, never in the URL. That is the same discipline `IdentityForm`
 * already applies to patient inputs on the v2 surface.
 *
 * Everything else is delegated: `ResolutionFlow` is a pure presentational component (server-renderable
 * and therefore assertable with `renderToStaticMarkup`), and all resolution logic is in the Server
 * Action. This file holds no business rule, so there is nothing here for the flow's tests to miss.
 */
import { useActionState } from 'react';
import { resolveCoverageAction, V3_INITIAL_STATE } from '../../../lib/qualify/v3-actions';
import { ResolutionFlow } from './resolution-flow';

export function ResolutionFlowClient(): React.ReactElement {
  const [state, formAction] = useActionState(resolveCoverageAction, V3_INITIAL_STATE);
  return (
    <ResolutionFlow
      resolution={state.resolution}
      reason={state.reason}
      echo={state.echo}
      denied={state.denied}
      action={formAction}
    />
  );
}
