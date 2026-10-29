import process from 'node:process';
import type { InjectOptions } from 'fastify';
import type { JsonObject } from '../../shared/utils/json';
import { nn } from '../../shared/utils/type-assertion';
import { config } from '../config';

/**
 * Builds a request from Discord to the interactions route, signed with the preload's test key pair
 * as Discord signs it with its own.
 */
export async function discordInteractionRequest(interaction: JsonObject): Promise<InjectOptions> {
  const body = JSON.stringify(interaction);

  const timestamp = String(Math.floor(Date.now() / 1000));

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.fromBase64(nn(process.env.HOF_TEST_DISCORD_PRIVATE_KEY)),
    { name: 'Ed25519' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'Ed25519',
    privateKey,
    new TextEncoder().encode(timestamp + body)
  );

  return {
    method: 'POST',
    url: '/api/v1/discord/interactions',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': new Uint8Array(signature).toHex(),
      'x-signature-timestamp': timestamp
    },
    payload: body
  };
}

/**
 * A click on a button of a message in the moderation channel, by the moderator unless overridden.
 */
export function buttonClickInteraction(
  customId: string,
  {
    userId = nn(config.discord.moderatorIds[0]),
    interactionToken = 'interaction-token'
  }: { userId?: string; interactionToken?: string } = {}
): JsonObject {
  return {
    type: 3,
    id: '1300000000000000001',
    application_id: config.discord.applicationId,
    token: interactionToken,
    channel_id: config.discord.channelId,
    member: { user: { id: userId, username: 'moderator' } },
    data: { component_type: 2, custom_id: customId }
  };
}
