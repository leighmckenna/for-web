import { For, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useClientController } from "@revolt/client";
import { useNavigate } from "@revolt/routing";
import { useState } from "@revolt/state";
import { Button, Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { Modals } from "../types";

/**
 * Host name shown for an instance API URL
 */
function hostOf(instance: string) {
  try {
    return new URL(instance).host;
  } catch {
    return instance;
  }
}

/**
 * Modal listing the instances the user is signed into,
 * switching between them or adding another.
 */
export function SwitchInstanceModal(
  props: DialogProps & Modals & { type: "switch_instance" },
) {
  const state = useState();
  const controller = useClientController();
  const navigate = useNavigate();

  /**
   * Instances with stored sessions, always including the active one
   */
  const instances = () => {
    const list = state.auth.getInstances();
    return list.includes(controller.activeInstance())
      ? list
      : [controller.activeInstance(), ...list];
  };

  /**
   * Switch to another instance and land on its home
   */
  function switchTo(instance: string) {
    if (instance !== controller.activeInstance()) {
      controller.switchInstance(instance);
      navigate("/app", { replace: true });
    }

    props.onClose();
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Instances</Trans>}
      actions={[
        {
          text: <Trans>Add an instance</Trans>,
          onClick: () => {
            navigate("/login/instance");
            return true;
          },
        },
        { text: <Trans>Close</Trans> },
      ]}
    >
      <Column>
        <Text>
          <Trans>Each instance has its own account and communities.</Trans>
        </Text>
        <For each={instances()}>
          {(instance) => (
            <Button
              variant={
                instance === controller.activeInstance() ? "tonal" : "text"
              }
              isDisabled={instance === controller.activeInstance()}
              onPress={() => switchTo(instance)}
            >
              {hostOf(instance)}
              <Show when={instance === controller.activeInstance()}>
                {" "}
                <Trans>(current)</Trans>
              </Show>
            </Button>
          )}
        </For>
      </Column>
    </Dialog>
  );
}
