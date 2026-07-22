export type OAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type OAuthTokenEndpointAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

export type OAuthClientCredentials = {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
};

export type OAuthAuthorizationServerMetadata = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
  grantTypesSupported?: string[];
  responseTypesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  clientIdMetadataDocumentSupported?: boolean;
};

export type OAuthPkcePair = {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

export type OAuthAuthorizationRequest = OAuthPkcePair & {
  authorizationUrl: string;
  state: string;
};

export type OAuthTokenSet = {
  accessToken: string;
  tokenType: "Bearer";
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
};

export type OAuthStoredToken = OAuthTokenSet & {
  issuer: string;
  clientId: string;
  resource?: string;
};

export type OAuthTokenStore = {
  load(key: string): Promise<OAuthStoredToken | undefined>;
  save(key: string, token: OAuthStoredToken): Promise<void>;
  delete(key: string): Promise<void>;
};

export type OAuthDiscoveryMethod = "oauth_authorization_server" | "openid_configuration";

export type OAuthDiagnosticEvent =
  | {
      event: "oauth.metadata_discovery_attempted";
      level: "debug";
      attempt: number;
      method: OAuthDiscoveryMethod;
    }
  | {
      event: "oauth.metadata_discovery_failed";
      level: "debug";
      attempt: number;
      method: OAuthDiscoveryMethod;
      status?: number;
      errorIdentity?: string;
    }
  | {
      event: "oauth.metadata_discovery_succeeded";
      level: "info";
      attempt: number;
      method: OAuthDiscoveryMethod;
    }
  | {
      event: "oauth.token_request_failed";
      level: "warn";
      grantType: "authorization_code" | "refresh_token";
      status?: number;
      oauthError?: string;
      errorIdentity?: string;
    }
  | {
      event: "oauth.token_request_succeeded";
      level: "info";
      grantType: "authorization_code" | "refresh_token";
      refreshTokenIssued: boolean;
      expiresAtPresent: boolean;
    }
  | {
      event: "oauth.authorization_started";
      level: "info";
      scopeCount: number;
    }
  | {
      event: "oauth.authorization_callback_received";
      level: "debug";
    }
  | {
      event: "oauth.authorization_succeeded";
      level: "info";
      scopeCount: number;
      refreshTokenAvailable: boolean;
    }
  | {
      event: "oauth.authorization_failed";
      level: "warn";
      oauthError?: string;
      errorIdentity?: string;
    }
  | {
      event: "oauth.token_invalidated";
      level: "info";
      reason: "binding_changed" | "refresh_rejected" | "signed_out";
    };

export type OAuthDiagnosticHandler = (event: OAuthDiagnosticEvent) => void;
