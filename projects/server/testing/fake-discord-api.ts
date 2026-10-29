import type { JsonObject } from '../../shared/utils/json';
import { config } from '../config';
import { DiscordService } from '../services/discord.service';
import { fetchStub } from './fetch-stub';

/**
 * A message the fake holds, as posted.
 */
export interface FakeDiscordMessage {
  readonly id: string;
  readonly body: JsonObject;
}

/**
 * Stateful stand-in for Discord's REST API, answering on the fetch stub like Discord does for the
 * moderation channel: it posts messages with sequential snowflake IDs and deletes them, answering
 * Discord's unknown-message error for one already gone.
 * Any other channel or route answers 404, and a request without the bot token answers 401.
 */
export class FakeDiscordApi {
  /**
   * The channel's messages still standing, in posting order.
   */
  public readonly messages: FakeDiscordMessage[] = [];

  /**
   * IDs of the messages deleted, in order, including deletions of a message already gone.
   */
  public readonly deletedMessageIds: string[] = [];

  /**
   * Runs before a post is answered, to hold it or act while it is in flight.
   */
  public beforePost: (() => Promise<void>) | undefined;

  private failingPostsCount = 0;

  private lastMessageId = 1_200_000_000_000_000_000n;

  /**
   * Installs the fake on the fetch stub, for the current test.
   */
  public install(): this {
    fetchStub.handle(DiscordService.apiUrl, request => this.handle(request));

    return this;
  }

  /**
   * Answers the next posts with a 500.
   */
  public failNextPosts(count: number): void {
    this.failingPostsCount = count;
  }

  private handle(request: Request): Response | Promise<Response> {
    if (request.headers.get('authorization') != `Bot ${config.discord.botToken}`) {
      return Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 });
    }

    const messagesPath = `${DiscordService.apiUrl}/channels/${config.discord.channelId}/messages`;

    if (request.method == 'POST' && request.url == messagesPath) {
      return this.post(request);
    }

    if (request.method == 'DELETE' && request.url.startsWith(`${messagesPath}/`)) {
      return this.delete(request.url.slice(messagesPath.length + 1));
    }

    return Response.json({ message: '404: Not Found', code: 0 }, { status: 404 });
  }

  private async post(request: Request): Promise<Response> {
    const body = (await request.json()) as JsonObject;

    await this.beforePost?.();

    if (this.failingPostsCount > 0) {
      this.failingPostsCount--;

      return Response.json({ message: '500: Internal Server Error', code: 0 }, { status: 500 });
    }

    this.lastMessageId++;

    const message = { id: this.lastMessageId.toString(), body };

    this.messages.push(message);

    return Response.json({ id: message.id, channel_id: config.discord.channelId, ...body });
  }

  private delete(messageId: string): Response {
    this.deletedMessageIds.push(messageId);

    const index = this.messages.findIndex(message => message.id == messageId);

    if (index == -1) {
      return Response.json({ message: 'Unknown Message', code: 10_008 }, { status: 404 });
    }

    this.messages.splice(index, 1);

    return new Response(undefined, { status: 204 });
  }
}
