export interface RemoteConnection {
  readonly id: string;
  readonly sourceAddress: string;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code: number, reason: string): void;
  onMessage(listener: (data: string) => void): () => void;
  onClose(listener: () => void): () => void;
}
