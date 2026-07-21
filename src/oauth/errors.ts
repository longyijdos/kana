export class OAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OAuthError";
  }
}

export class OAuthDiscoveryError extends OAuthError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OAuthDiscoveryError";
  }
}

export class OAuthProtocolError extends OAuthError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OAuthProtocolError";
  }
}

export class OAuthAuthorizationResponseError extends OAuthError {
  constructor(public readonly oauthError: string) {
    super(`OAuth authorization failed with error ${oauthError}.`);
    this.name = "OAuthAuthorizationResponseError";
  }
}

export class OAuthTokenEndpointError extends OAuthError {
  constructor(
    public readonly status: number,
    public readonly oauthError?: string,
  ) {
    super(
      oauthError === undefined
        ? `OAuth token endpoint returned HTTP ${status}.`
        : `OAuth token endpoint returned HTTP ${status} with error ${oauthError}.`,
    );
    this.name = "OAuthTokenEndpointError";
  }
}
