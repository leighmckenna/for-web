import { Accessor, Setter, createMemo, createSignal } from "solid-js";

import { detect } from "detect-browser";
import { API, Client, ConnectionState } from "stoat.js";
import { ProtocolV1 } from "stoat.js/lib/events/v1";

import { BRAND_NAME, CONFIGURATION } from "@revolt/common";
import { ModalControllerExtended } from "@revolt/modal";
import type { State as ApplicationState } from "@revolt/state";
import type { Session } from "@revolt/state/stores/Auth";
import { killServiceWorkerSubscription } from "./NotificationsController";
import { type DiscoveredInstance, DEFAULT_INSTANCE } from "./instances";

export enum State {
  Ready = "Ready",
  LoggingIn = "Logging In",
  Onboarding = "Onboarding",
  Error = "Error",
  Dispose = "Dispose",
  Connecting = "Connecting",
  Connected = "Connected",
  Disconnected = "Disconnected",
  Reconnecting = "Reconnecting",
  Offline = "Offline",
}

export enum TransitionType {
  LoginUncached = "uncached login",
  LoginCached = "cached login",
  SocketConnected = "socket connected",
  DeviceOffline = "device offline",
  DeviceOnline = "device online",
  PermanentFailure = "permanent failure",
  TemporaryFailure = "temporary failure",
  UserCreated = "user created",
  NoUser = "no user",
  Cancel = "cancel",
  Dispose = "dispose",
  DisposeOnly = "dispose only",
  Dismiss = "dismiss",
  Ready = "ready",
  Retry = "retry",
  Logout = "logout",
  /** Disconnect and reset without invalidating the stored session
   *  (used when switching to another instance) */
  Suspend = "suspend",
}

export type Transition =
  | {
      type: TransitionType.LoginUncached | TransitionType.LoginCached;
      session: Session;
    }
  | {
      type: TransitionType.PermanentFailure;
      error: string;
    }
  | {
      type:
        | TransitionType.NoUser
        | TransitionType.UserCreated
        | TransitionType.TemporaryFailure
        | TransitionType.SocketConnected
        | TransitionType.DeviceOffline
        | TransitionType.DeviceOnline
        | TransitionType.Cancel
        | TransitionType.Dismiss
        | TransitionType.Ready
        | TransitionType.Retry
        | TransitionType.Dispose
        | TransitionType.DisposeOnly
        | TransitionType.Logout
        | TransitionType.Suspend;
    };

type PolicyAttentionRequired = [
  ProtocolV1["types"]["policyChange"][],
  () => Promise<void>,
];

export class Lifecycle {
  #controller: ClientController;
  readonly instanceUrl: string;

  readonly state: Accessor<State>;
  #setStateSetter: Setter<State>;

  readonly loadedOnce: Accessor<boolean>;
  #setLoadedOnce: Setter<boolean>;

  readonly policyAttentionRequired: Accessor<
    undefined | PolicyAttentionRequired
  >;
  #policyAttentionRequired: Setter<undefined | PolicyAttentionRequired>;

  client: Client;

  #connectionFailures = 0;
  #permanentError: string | undefined;
  #retryTimeout: number | undefined;
  #remoteLogout = false;

  constructor(controller: ClientController, instanceUrl: string) {
    this.#controller = controller;
    this.instanceUrl = instanceUrl;

    this.onState = this.onState.bind(this);
    this.onReady = this.onReady.bind(this);
    this.onPolicyChanges = this.onPolicyChanges.bind(this);

    const [state, setState] = createSignal(State.Ready);
    this.state = state;
    this.#setStateSetter = setState;

    const [loadedOnce, setLoadedOnce] = createSignal(false);
    this.loadedOnce = loadedOnce;
    this.#setLoadedOnce = setLoadedOnce;

    const [policyAttentionRequired, setPolicyAttentionRequired] = createSignal<
      undefined | PolicyAttentionRequired
    >(undefined);

    this.policyAttentionRequired = policyAttentionRequired;
    this.#policyAttentionRequired = setPolicyAttentionRequired;

    this.client = null!;
    this.dispose(false);
  }

  private dispose(remoteLogout: boolean) {
    if (this.client) {
      if (remoteLogout) {
        // invalidates the session server-side and tears the socket down
        this.client.logout();
      } else {
        // tear down locally, keeping the stored session usable
        this.client.events.removeAllListeners();
        this.client.removeAllListeners();
        this.client.events.disconnect();
      }
    }

    this.client = new Client({
      baseURL: this.instanceUrl,
      autoReconnect: false,
      syncUnreads: true,
      debug: import.meta.env.DEV,
      channelIsMuted: (channel) =>
        this.#controller.state.notifications.isMuted(channel),
      channelExclusiveMuted: (channel) =>
        this.#controller.state.notifications.isChannelMuted(channel),
    });

    // configuration must be present before connect() — the SDK will not
    // fetch it for existing sessions and falls back to the official ws URL
    const cached = this.#controller.getInstanceConfig(this.instanceUrl);
    if (cached) {
      this.client.configuration = cached;
    } else if (this.instanceUrl === DEFAULT_INSTANCE) {
      this.client.configuration = {
        revolt: String(),
        app: String(),
        build: {} as never,
        features: {
          autumn: {
            enabled: true,
            url: CONFIGURATION.DEFAULT_MEDIA_URL,
          },
          january: {
            enabled: true,
            url: CONFIGURATION.DEFAULT_PROXY_URL,
          },
          captcha: {} as never,
          email: true,
          invite_only: false,
          livekit: {
            enabled: false,
            nodes: [],
          },
          legal_links: {} as never,
          limits: {} as never,
        },
        vapid: String(),
        ws: CONFIGURATION.DEFAULT_WS_URL,
      };
    }
    // otherwise leave unset; #connect() fetches it before opening the socket

    this.client.events.on("state", this.onState);
    this.client.on("ready", this.onReady);
    this.client.on("policyChanges", this.onPolicyChanges);
  }

  /**
   * Open the socket, fetching instance configuration first if we
   * don't have it yet (the SDK requires it for the ws URL).
   */
  #connect() {
    if (this.client.configuration) {
      this.client.connect();
    } else {
      this.client.api
        .get("/")
        .then((configuration) => {
          this.client.configuration = configuration;
          this.client.connect();
        })
        .catch(() =>
          this.transition({ type: TransitionType.TemporaryFailure }),
        );
    }
  }

  #enter(nextState: State) {
    if (import.meta.env.DEV) {
      console.info(
        "[lifecycle]",
        this.instanceUrl,
        "entering state",
        nextState,
      );
    }

    this.#setStateSetter(nextState);

    // Clean up retry timer
    if (this.#retryTimeout) {
      clearTimeout(this.#retryTimeout);
      this.#retryTimeout = undefined;
    }

    switch (nextState) {
      case State.LoggingIn:
        this.client.api.get("/onboard/hello").then(({ onboarding }) => {
          if (onboarding) {
            this.transition({
              type: TransitionType.NoUser,
            });
          } else {
            this.#connect();
          }
        });

        break;
      case State.Connecting:
      case State.Reconnecting:
        this.#connect();
        break;
      case State.Connected:
        this.#controller.state.auth.markValid(this.instanceUrl);
        this.#setLoadedOnce(true);
        this.#connectionFailures = 0;
        break;
      case State.Dispose:
        this.dispose(this.#remoteLogout);
        this.#remoteLogout = false;
        this.transition({
          type: TransitionType.Ready,
        });
        this.#setLoadedOnce(false);
        break;
      case State.Disconnected:
        this.#connectionFailures++;

        if (!navigator.onLine) {
          this.transition({
            type: TransitionType.DeviceOffline,
          });
        } else {
          const retryIn =
            (Math.pow(2, this.#connectionFailures) - 1) *
            (0.8 + Math.random() * 0.4);

          console.info(
            "Will try to reconnect in",
            retryIn.toFixed(2),
            "seconds!",
          );

          this.#retryTimeout = setTimeout(() => {
            this.#retryTimeout = undefined;
            this.transition({
              type: TransitionType.Retry,
            });
          }, retryIn * 1e3) as never;
        }
        break;
    }
  }

  /**
   * Tear down towards State.Dispose, optionally invalidating the
   * session server-side.
   */
  #teardown(remoteLogout: boolean) {
    this.#remoteLogout = remoteLogout;
    this.#enter(State.Dispose);
  }

  transition(transition: Transition) {
    console.debug(
      "Received transition",
      transition.type,
      "on",
      this.instanceUrl,
    );

    if (transition.type === TransitionType.DisposeOnly) {
      this.dispose(false);
      return;
    }

    const currentState = this.state();

    // switching away is valid from any state that holds a client
    if (transition.type === TransitionType.Suspend) {
      if (currentState !== State.Ready && currentState !== State.Dispose) {
        this.#teardown(false);
      }
      return;
    }

    switch (currentState) {
      case State.Ready:
        if (transition.type === TransitionType.LoginUncached) {
          this.client.useExistingSession({
            ...transition.session,
            user_id: transition.session.userId,
          });

          this.#enter(State.LoggingIn);
        } else if (transition.type === TransitionType.LoginCached) {
          this.client.useExistingSession({
            ...transition.session,
            user_id: transition.session.userId,
          });

          this.#enter(State.Connecting);
        }
        break;
      case State.LoggingIn:
        switch (transition.type) {
          case TransitionType.SocketConnected:
            this.#enter(State.Connected);
            break;
          case TransitionType.NoUser:
            this.#enter(State.Onboarding);
            break;
          case TransitionType.PermanentFailure:
          case TransitionType.TemporaryFailure:
            // TODO: relay error
            this.#enter(State.Error);
            break;
        }
        break;
      case State.Onboarding:
        if (transition.type === TransitionType.UserCreated) {
          this.#enter(State.Connecting);
        } else if (transition.type === TransitionType.Cancel) {
          this.#teardown(true);
        }
        break;
      case State.Error:
        if (transition.type === TransitionType.Dismiss) {
          this.#teardown(false);
        }
        break;
      case State.Dispose:
        if (transition.type === TransitionType.Ready) {
          this.#enter(State.Ready);
        }
        break;
      case State.Connecting:
        switch (transition.type) {
          case TransitionType.SocketConnected:
            this.#enter(State.Connected);
            break;
          case TransitionType.TemporaryFailure:
            this.#enter(State.Disconnected);
            break;
          case TransitionType.PermanentFailure:
            this.#permanentError = transition.error;
            this.#enter(State.Error);
            break;
          case TransitionType.Logout:
            this.#teardown(true);
            break;
        }
        break;
      case State.Connected:
        switch (transition.type) {
          case TransitionType.TemporaryFailure:
            this.#enter(State.Disconnected);
            break;
          case TransitionType.Logout:
            this.#teardown(true);
            break;
        }
        break;
      case State.Disconnected:
        switch (transition.type) {
          case TransitionType.DeviceOffline:
            this.#enter(State.Offline);
            break;
          case TransitionType.Retry:
            this.#enter(State.Reconnecting);
            break;
          case TransitionType.Logout:
            this.#teardown(true);
            break;
        }
        break;
      case State.Reconnecting:
        switch (transition.type) {
          case TransitionType.SocketConnected:
            this.#enter(State.Connected);
            break;
          case TransitionType.TemporaryFailure:
            this.#enter(State.Disconnected);
            break;
          case TransitionType.PermanentFailure:
            // TODO: relay error
            this.#enter(State.Error);
            break;
          case TransitionType.Logout:
            this.#teardown(true);
            break;
        }
        break;
      case State.Offline:
        switch (transition.type) {
          case TransitionType.DeviceOnline:
            this.#enter(State.Reconnecting);
            break;
          case TransitionType.Retry:
            this.#enter(State.Reconnecting);
            break;
          case TransitionType.Logout:
            this.#teardown(true);
            break;
        }
        break;
    }

    if (currentState === this.state()) {
      console.error(
        "An unhandled transition occurred!",
        transition,
        "was received on",
        currentState,
      );
    }
  }

  private onReady() {
    this.transition({
      type: TransitionType.SocketConnected,
    });
  }

  private onPolicyChanges(
    changes: ProtocolV1["types"]["policyChange"][],
    ack: () => Promise<void>,
  ) {
    this.#policyAttentionRequired([
      changes,
      () => ack().then(() => this.#policyAttentionRequired(undefined)),
    ]);
  }

  private onState(state: ConnectionState) {
    switch (state) {
      case ConnectionState.Disconnected:
        if (this.client.events.lastError) {
          if (this.client.events.lastError.type === "revolt") {
            // if (this.client.events.lastError.data.type == 'InvalidSession') {

            this.transition({
              type: TransitionType.PermanentFailure,
              error: this.client.events.lastError.data.type,
            });

            break;
          }
        }

        this.transition({
          type: TransitionType.TemporaryFailure,
        });

        break;
    }
  }

  /**
   * Get the permanent error
   */
  get permanentError() {
    return this.#permanentError!;
  }
}

/**
 * Stable facade over whichever instance's Lifecycle is currently active.
 *
 * Components destructure `lifecycle` once from context; this object never
 * changes identity, while every access resolves through the reactive
 * active-instance signal — so UI tracking `lifecycle.state()` updates
 * when the user switches instance.
 */
export class ActiveLifecycle {
  #controller: ClientController;

  constructor(controller: ClientController) {
    this.#controller = controller;
    this.state = this.state.bind(this);
    this.loadedOnce = this.loadedOnce.bind(this);
    this.policyAttentionRequired = this.policyAttentionRequired.bind(this);
    this.transition = this.transition.bind(this);
  }

  #current(): Lifecycle {
    return this.#controller.lifecycleFor(this.#controller.activeInstance());
  }

  state(): State {
    return this.#current().state();
  }

  loadedOnce(): boolean {
    return this.#current().loadedOnce();
  }

  policyAttentionRequired(): undefined | PolicyAttentionRequired {
    return this.#current().policyAttentionRequired();
  }

  get client(): Client {
    return this.#current().client;
  }

  transition(transition: Transition) {
    this.#current().transition(transition);
  }

  get permanentError() {
    return this.#current().permanentError;
  }
}

/**
 * Controls the lifecycles of clients, one per instance the user is
 * signed into; exactly one instance is "active" (rendered) at a time.
 */
export default class ClientController {
  /**
   * Lifecycle facade for the active instance
   */
  readonly lifecycle: ActiveLifecycle;

  /**
   * Reference to application state
   */
  readonly state: ApplicationState;

  /**
   * The active instance's API URL (reactive)
   */
  readonly activeInstance: Accessor<string>;
  #setActiveInstance: Setter<string>;

  #lifecycles = new Map<string, Lifecycle>();
  #apis = new Map<string, API.API>();

  /**
   * Configurations for instances being added that have no stored session yet
   */
  #pendingConfigs = new Map<string, API.RevoltConfig>();

  /**
   * A memo to prevent isLoggedIn from bouncing when reconnecting
   */
  private isLoggedInState: Accessor<boolean>;

  /**
   * Construct new client controller
   */
  constructor(state: ApplicationState) {
    this.state = state;

    const [activeInstance, setActiveInstance] = createSignal(
      state.auth.getActiveInstance() ?? DEFAULT_INSTANCE,
    );
    this.activeInstance = activeInstance;
    this.#setActiveInstance = setActiveInstance;

    this.lifecycle = new ActiveLifecycle(this);

    this.login = this.login.bind(this);
    this.logout = this.logout.bind(this);
    this.selectUsername = this.selectUsername.bind(this);
    this.isLoggedIn = this.isLoggedIn.bind(this);
    this.isError = this.isError.bind(this);
    this.switchInstance = this.switchInstance.bind(this);
    this.addInstance = this.addInstance.bind(this);

    this.isLoggedInState = createMemo(() =>
      [
        State.Connecting,
        State.Connected,
        State.Disconnected,
        State.Offline,
        State.Reconnecting,
      ].includes(this.lifecycle.state()),
    );

    const session = state.auth.getSession(this.activeInstance());
    if (session) {
      this.lifecycleFor(this.activeInstance()).transition({
        type: TransitionType.LoginCached,
        session,
      });
    }
  }

  /**
   * Get (or lazily create) the lifecycle for an instance.
   */
  lifecycleFor(instance: string): Lifecycle {
    let lifecycle = this.#lifecycles.get(instance);
    if (!lifecycle) {
      lifecycle = new Lifecycle(this, instance);
      this.#lifecycles.set(instance, lifecycle);
    }
    return lifecycle;
  }

  /**
   * Unauthenticated API client for the active instance
   */
  get api(): API.API {
    return this.apiFor(this.activeInstance());
  }

  /**
   * Unauthenticated API client for an instance.
   */
  apiFor(instance: string): API.API {
    let api = this.#apis.get(instance);
    if (!api) {
      api = new API.API({ baseURL: instance });
      this.#apis.set(instance, api);
    }
    return api;
  }

  /**
   * Best known configuration for an instance (stored, or pending add).
   */
  getInstanceConfig(instance: string): API.RevoltConfig | undefined {
    return (
      this.state.auth.getConfig(instance) ?? this.#pendingConfigs.get(instance)
    );
  }

  getCurrentClient() {
    return this.lifecycleFor(this.activeInstance()).client;
  }

  isLoggedIn() {
    return this.isLoggedInState();
  }

  isError() {
    return this.lifecycle.state() === State.Error;
  }

  /**
   * Make another instance the active one, disconnecting the current
   * client without invalidating its stored session.
   */
  switchInstance(instance: string) {
    if (instance === this.activeInstance()) return;

    this.lifecycleFor(this.activeInstance()).transition({
      type: TransitionType.Suspend,
    });

    this.state.auth.setActiveInstance(instance);
    this.#setActiveInstance(instance);

    const session = this.state.auth.getSession(instance);
    const target = this.lifecycleFor(instance);
    if (session && target.state() === State.Ready) {
      target.transition({
        type: TransitionType.LoginCached,
        session,
      });
    }
  }

  /**
   * Register a newly discovered instance and switch to it; the login
   * flow then operates against it (its configuration is kept pending
   * until a session is stored).
   */
  addInstance(discovered: DiscoveredInstance) {
    this.#pendingConfigs.set(discovered.apiUrl, discovered.config);
    this.switchInstance(discovered.apiUrl);
  }

  /**
   * Login to the active instance given a set of credentials
   * @param credentials Credentials
   */
  async login(credentials: API.DataLogin, modals: ModalControllerExtended) {
    const browser = detect();

    // Generate a friendly name for this browser
    let friendly_name;
    if (browser) {
      let { name, os } = browser as { name: string; os: string };
      if (name === "ios") {
        name = "safari";
      } else if (name === "fxios") {
        name = "firefox";
      } else if (name === "crios") {
        name = "chrome";
      } else if (os === "Mac OS" && navigator.maxTouchPoints > 0) {
        os = "iPadOS";
      }

      friendly_name = `${BRAND_NAME} for Web (${name} on ${os})`;
    } else {
      friendly_name = `${BRAND_NAME} for Web (Unknown Device)`;
    }

    const instance = this.activeInstance();

    // Try to login with given credentials
    let session = await this.apiFor(instance).post("/auth/session/login", {
      ...credentials,
      friendly_name,
    });

    // Prompt for MFA verification if necessary
    if (session.result === "MFA") {
      const { allowed_methods } = session;
      while (session.result === "MFA") {
        const mfa_response: API.MFAResponse | undefined = await new Promise(
          (callback) =>
            modals.openModal({
              type: "mfa_flow",
              state: "unknown",
              available_methods: allowed_methods,
              callback,
            }),
        );

        if (typeof mfa_response === "undefined") {
          break;
        }

        try {
          session = await this.apiFor(instance).post("/auth/session/login", {
            mfa_response,
            mfa_ticket: session.ticket,
            friendly_name,
          });
        } catch (err) {
          console.error("Failed login:", err);
        }
      }

      if (session.result === "MFA") {
        throw "Cancelled";
      }
    }

    if (session.result === "Disabled") {
      // TODO
      alert("Account is disabled, run special logic here.");
      return;
    }

    const createdSession = {
      _id: session._id,
      token: session.token,
      userId: session.user_id,
      valid: false,
    };

    this.state.auth.setSession(
      instance,
      createdSession,
      this.#pendingConfigs.get(instance),
    );
    this.#pendingConfigs.delete(instance);

    this.lifecycleFor(instance).transition({
      type: TransitionType.LoginUncached,
      session: createdSession,
    });
  }

  async selectUsername(username: string) {
    await this.lifecycle.client.api.post("/onboard/complete", {
      username,
    });

    this.lifecycle.transition({
      type: TransitionType.UserCreated,
    });
  }

  /**
   * Log out of the active instance; if the user is signed into other
   * instances, the first remaining one becomes active.
   */
  logout() {
    const instance = this.activeInstance();

    this.state.settings.resetNotificationsState();
    killServiceWorkerSubscription(this.getCurrentClient(), true);
    this.state.auth.removeSession(instance);
    this.lifecycleFor(instance).transition({
      type: TransitionType.Logout,
    });

    const next = this.state.auth.getActiveInstance();
    if (next && next !== instance) {
      this.#setActiveInstance(next);

      const session = this.state.auth.getSession(next);
      const target = this.lifecycleFor(next);
      if (session && target.state() === State.Ready) {
        target.transition({
          type: TransitionType.LoginCached,
          session,
        });
      }
    }
  }

  dispose() {
    for (const lifecycle of this.#lifecycles.values()) {
      lifecycle.transition({
        type: TransitionType.DisposeOnly,
      });
    }
  }
}
