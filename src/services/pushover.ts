// src/services/pushover.ts
export interface PushoverService {
  send(title: string, message: string, priority?: number): Promise<void>;
  sendBudgetWarning(percentUsed: number, spent: number, budget: number): Promise<void>;
  sendBudgetExceeded(spent: number, budget: number): Promise<void>;
  sendProcessingFailed(entryId: string, url: string, error: string): Promise<void>;
}

export function createPushoverService(
  userKey: string | undefined,
  appToken: string | undefined
): PushoverService {
  const isConfigured = Boolean(userKey && appToken);

  async function send(title: string, message: string, priority: number = 0): Promise<void> {
    if (!isConfigured) {
      console.log(`[Pushover disabled] ${title}: ${message}`);
      return;
    }

    try {
      const response = await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: appToken,
          user: userKey,
          title,
          message,
          priority,
        }),
      });

      if (!response.ok) {
        console.error('Failed to send Pushover notification:', response.status);
      }
    } catch (error) {
      console.error('Error sending Pushover notification:', error);
    }
  }

  async function sendBudgetWarning(
    percentUsed: number,
    spent: number,
    budget: number
  ): Promise<void> {
    await send(
      'Unread Cast - Budget Warning',
      `Monthly spend at ${percentUsed.toFixed(0)}% ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Processing will pause at 100%.`
    );
  }

  async function sendBudgetExceeded(spent: number, budget: number): Promise<void> {
    await send(
      'Unread Cast - Budget Exceeded',
      `Monthly budget exceeded ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Processing is paused until next month.`,
      1 // High priority
    );
  }

  async function sendProcessingFailed(entryId: string, url: string, error: string): Promise<void> {
    await send(
      'Unread Cast - Processing Failed',
      `Entry ${entryId} failed after max retries.\nURL: ${url}\nError: ${error}`
    );
  }

  return {
    send,
    sendBudgetWarning,
    sendBudgetExceeded,
    sendProcessingFailed,
  };
}
