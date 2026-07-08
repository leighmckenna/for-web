import type { API } from "stoat.js";

import { CONFIGURATION } from "@revolt/common";

import { State } from "..";

import { AbstractStore } from ".";

export type Session = {
  _id: string;
  token: string;
  userId: string;
  valid: boolean;
};

/**
 * Everything we know about an instance the user has signed into.
 */
export type InstanceRecord = {
  session: Session;
  /**
   * The instance's self-reported configuration (`GET /` on its API),
   * cached so clients can be constructed synchronously before connect.
   * Absent for the default instance, which falls back to build-time URLs.
   */
  config?: API.RevoltConfig;
};

export type TypeAuth = {
  /**
   * Sessions keyed by canonical instance API URL
   */
  sessions: Record<string, InstanceRecord>;

  /**
   * Instance the interface is currently signed into
   */
  activeInstance?: string;

  /**
   * Session information (legacy single-instance shape, migrated by clean())
   */
  session?: Session;
};

/**
 * Validate a session-shaped object.
 */
function cleanSession(input?: Partial<Session>): Session | undefined {
  if (
    typeof input === "object" &&
    typeof input?._id === "string" &&
    typeof input.token === "string" &&
    typeof input.userId === "string" &&
    input.valid
  ) {
    return {
      _id: input._id,
      token: input.token,
      userId: input.userId,
      valid: true,
    };
  }
}

/**
 * Authentication details store
 */
export class Auth extends AbstractStore<"auth", TypeAuth> {
  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "auth");
  }

  /**
   * Hydrate external context
   */
  hydrate(): void {
    if (CONFIGURATION.DEVELOPMENT_TOKEN && CONFIGURATION.DEVELOPMENT_USER_ID) {
      this.setSession(CONFIGURATION.DEFAULT_API_URL, {
        _id: CONFIGURATION.DEVELOPMENT_SESSION_ID ?? "0",
        token: CONFIGURATION.DEVELOPMENT_TOKEN,
        userId: CONFIGURATION.DEVELOPMENT_USER_ID,
        valid: true,
      });
    }
  }

  /**
   * Generate default values
   */
  default(): TypeAuth {
    return {
      sessions: {},
      activeInstance: undefined,
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeAuth>): TypeAuth {
    const sessions: Record<string, InstanceRecord> = {};

    if (typeof input.sessions === "object") {
      for (const [url, record] of Object.entries(input.sessions ?? {})) {
        const session = cleanSession(record?.session);
        if (typeof url === "string" && url && session) {
          sessions[url] = { session, config: record.config };
        }
      }
    }

    // migrate the legacy single-session shape onto the default instance
    const legacy = cleanSession(input.session);
    if (legacy && !sessions[CONFIGURATION.DEFAULT_API_URL]) {
      sessions[CONFIGURATION.DEFAULT_API_URL] = { session: legacy };
    }

    let activeInstance =
      typeof input.activeInstance === "string"
        ? input.activeInstance
        : undefined;
    if (!activeInstance || !sessions[activeInstance]) {
      activeInstance = Object.keys(sessions)[0];
    }

    return {
      sessions,
      activeInstance,
    };
  }

  /**
   * All instances with stored sessions.
   * @returns Canonical instance API URLs
   */
  getInstances(): string[] {
    return Object.keys(this.get().sessions);
  }

  /**
   * Get the instance the interface should sign into.
   */
  getActiveInstance(): string | undefined {
    const data = this.get();
    if (data.activeInstance && data.sessions[data.activeInstance])
      return data.activeInstance;
    return Object.keys(data.sessions)[0];
  }

  /**
   * Set the instance the interface is signed into.
   */
  setActiveInstance(instance: string) {
    this.set("activeInstance", instance);
  }

  /**
   * Get the session for an instance.
   * @param instance Instance API URL (defaults to the active instance)
   * @returns Session
   */
  getSession(instance?: string) {
    const url = instance ?? this.getActiveInstance();
    return url ? this.get().sessions[url]?.session : undefined;
  }

  /**
   * Get the cached configuration for an instance.
   */
  getConfig(instance: string): API.RevoltConfig | undefined {
    return this.get().sessions[instance]?.config;
  }

  /**
   * Store a session (and optionally the instance's configuration).
   */
  setSession(instance: string, session: Session, config?: API.RevoltConfig) {
    this.set("sessions", instance, {
      session,
      config: config ?? this.get().sessions[instance]?.config,
    });
    this.set("activeInstance", instance);
  }

  /**
   * Remove the session for an instance.
   */
  removeSession(instance: string) {
    this.set("sessions", instance, undefined!);

    if (this.get().activeInstance === instance) {
      this.set("activeInstance", Object.keys(this.get().sessions)[0]!);
    }
  }

  /**
   * Mark an instance's session as valid
   */
  markValid(instance: string) {
    const record = this.get().sessions[instance];
    if (record && !record.session.valid) {
      this.set("sessions", instance, "session", "valid", true);
    }
  }
}
