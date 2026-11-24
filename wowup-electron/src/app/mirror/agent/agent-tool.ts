export interface AgentToolContext {
  progress(message: string): void;
}

export type AgentToolHandler = (args: Record<string, unknown>, ctx: AgentToolContext) => Promise<unknown>;

export type AgentToolSet = Record<string, AgentToolHandler>;
