import { Show, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useClientController } from "@revolt/client";
import { discoverInstance } from "@revolt/client/instances";
import { useNavigate } from "@revolt/routing";
import { useState } from "@revolt/state";
import { Button, Column, Text, TextField } from "@revolt/ui";

import { FlowTitle } from "./Flow";
import { Form } from "./Form";

/**
 * Pull a server invite code out of pasted input, e.g.
 * https://example.com/invite/AbCdEf
 */
function inviteCodeFromInput(input: string): string | undefined {
  return /\/invite\/([A-Za-z0-9-]+)/.exec(input)?.[1];
}

/**
 * Flow for connecting to a different instance ("add a server by URL")
 */
export default function FlowInstance() {
  const { t } = useLingui();
  const state = useState();
  const controller = useClientController();
  const navigate = useNavigate();

  const [busy, setBusy] = createSignal(false);

  /**
   * Discover the instance behind the pasted input and make it active
   */
  async function add(data: FormData) {
    const input = (data.get("instance") as string).trim();
    if (!input) return;

    setBusy(true);
    try {
      const discovered = await discoverInstance(input);

      controller.addInstance(discovered);

      // pasted a server invite? go join it once signed in
      const invite = inviteCodeFromInput(input);
      if (invite) {
        state.layout.setNextPath(`/invite/${invite}`);
      }

      const session = state.auth.getSession(discovered.apiUrl);
      navigate(session ? "/app" : "/login", { replace: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <FlowTitle subtitle={<Trans>Connect to a self-hosted server</Trans>}>
        <Trans>Add an instance</Trans>
      </FlowTitle>
      <Form onSubmit={add}>
        <label>
          <TextField
            required
            type="text"
            name="instance"
            autocomplete="off"
            label={t`Instance`}
            placeholder={t`chat.example.com or an invite link`}
          />
        </label>
        <Text class="label" size="small">
          <Trans>
            Enter the domain of the instance, or paste an invite link from it.
            Your account on this instance stays signed in — each instance has
            its own accounts.
          </Trans>
        </Text>
        <Column>
          <Button isDisabled={busy()}>
            <Show when={busy()} fallback={<Trans>Connect</Trans>}>
              <Trans>Looking for the instance…</Trans>
            </Show>
          </Button>
          <a href="/login">
            <Column>
              <Button variant="text">
                <Trans>Back</Trans>
              </Button>
            </Column>
          </a>
        </Column>
      </Form>
    </>
  );
}
