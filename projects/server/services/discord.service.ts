import { Injectable } from '@nestjs/common';
import * as Bun from 'bun';
import LazyPromise from 'p-lazy';
import { z } from 'zod';
import { seconds } from '../../shared/utils/duration';
import type { JsonObject } from '../../shared/utils/json';
import { config } from '../config';

/**
 * Client of Discord's REST API, posting to and deleting from the moderation channel and answering
 * interactions, and verifier of the interactions Discord sends.
 * Plain `fetch` with the bot token: no SDK, no gateway connection.
 */
@Injectable()
export class DiscordService {
  public static readonly apiUrl = 'https://discord.com/api/v10';

  /**
   * Per call, so a stalled Discord holds neither a batch nor the shutdown that waits for it.
   */
  private static readonly timeoutSeconds = 10;

  /**
   * Discord's JSON error code for a message that no longer exists.
   */
  private static readonly unknownMessageCode = 10_008;

  private static readonly messageSchema = z.looseObject({ id: z.string() });

  /**
   * The application's public key, imported once, on the first interaction.
   */
  private readonly publicKey = LazyPromise.from(() =>
    crypto.subtle.importKey(
      'raw',
      Buffer.from(config.discord.publicKey, 'hex'),
      { name: 'Ed25519' },
      false,
      ['verify']
    )
  );

  /**
   * Posts a message to the moderation channel.
   *
   * @returns The ID of the posted message.
   */
  public async createMessage(message: JsonObject): Promise<string> {
    const body = await this.request('POST', this.messagesPath(), `post a message`, message);

    return DiscordService.messageSchema.parse(JSON.parse(body)).id;
  }

  /**
   * Deletes a message of the moderation channel.
   * Only a message already gone, ex. removed by hand, counts as deleted: an unknown channel, a
   * rejected token, or any other failure throws.
   */
  public async deleteMessage(messageId: string): Promise<void> {
    try {
      await this.request(
        'DELETE',
        `${this.messagesPath()}/${messageId}`,
        `delete message ${messageId}`
      );
    } catch (error) {
      if (error instanceof DiscordApiError && error.code == DiscordService.unknownMessageCode) {
        return;
      }

      throw error;
    }
  }

  /**
   * Sends a follow-up message to an interaction already answered, through its token.
   */
  public async createFollowupMessage(interactionToken: string, message: JsonObject): Promise<void> {
    await this.request(
      'POST',
      `/webhooks/${config.discord.applicationId}/${interactionToken}`,
      `send a follow-up message`,
      message
    );
  }

  /**
   * Checks that an interaction request comes from Discord: its Ed25519 signature, over the
   * timestamp and the raw body, verifies against the application's public key.
   */
  public async verifyInteractionSignature(
    rawBody: Uint8Array,
    signature: string,
    timestamp: string
  ): Promise<boolean> {
    // A malformed hex signature decodes to bytes that fail the verification.
    return crypto.subtle.verify(
      'Ed25519',
      await this.publicKey,
      Buffer.from(signature, 'hex'),
      Buffer.concat([Buffer.from(timestamp), rawBody])
    );
  }

  private messagesPath(): string {
    return `/channels/${config.discord.channelId}/messages`;
  }

  /**
   * Sends a request, then waits out the rate limit when it exhausted its bucket, so the next call
   * of a sequential batch stays within it.
   *
   * @returns The response body.
   *
   * @throws {DiscordApiError} For an error status.
   */
  private async request(
    method: string,
    path: string,
    action: string,
    body?: JsonObject
  ): Promise<string> {
    // The signal also aborts reading the body, which then rejects with the timeout too.
    const response = await fetch(`${DiscordService.apiUrl}${path}`, {
      method,
      headers: {
        'authorization': `Bot ${config.discord.botToken}`,
        'user-agent': `DiscordBot (${config.http.baseUrl}, 1.0)`,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(seconds(DiscordService.timeoutSeconds))
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new DiscordApiError(action, response, responseText);
    }

    const remaining = response.headers.get('x-ratelimit-remaining');
    const resetAfter = Number(response.headers.get('x-ratelimit-reset-after'));

    if (remaining == '0' && resetAfter > 0) {
      await Bun.sleep(seconds(resetAfter));
    }

    return responseText;
  }
}

/**
 * An error status from Discord's API, with the JSON error code its body carries, if any.
 */
export class DiscordApiError extends Error {
  private static readonly bodySchema = z.looseObject({ code: z.number() });

  public readonly code: number | undefined;

  public constructor(action: string, response: Response, responseText: string) {
    super(
      `Failed to ${action} on Discord (${response.status} ${response.statusText}): ${responseText}`
    );

    this.code = DiscordApiError.parseCode(responseText);
  }

  private static parseCode(responseText: string): number | undefined {
    try {
      return DiscordApiError.bodySchema.parse(JSON.parse(responseText)).code;
    } catch {
      return undefined;
    }
  }
}
