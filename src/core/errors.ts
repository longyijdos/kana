export class ContextWindowExceededError extends Error {
  constructor(message = "The model context window was exceeded.", options?: ErrorOptions) {
    super(message, options);
    this.name = "ContextWindowExceededError";
  }
}
