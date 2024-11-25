import { z } from "zod";
import { createAuthEndpoint } from "../../api/call";
import type { BetterAuthPlugin } from "../../types/plugins";
import { APIError } from "better-call";
import { setSessionCookie } from "../../cookies";
import { alphabet, generateRandomString } from "../../crypto";

interface MagicLinkOptions {
	/**
	 * Time in seconds until the magic link expires.
	 * @default (60 * 5) // 5 minutes
	 */
	expiresIn?: number;
	/**
	 * Send magic link implementation.
	 */
	sendMagicLink: (
		data: {
			email: string;
			url: string;
			token: string;
		},
		request?: Request,
	) => Promise<void> | void;
	/**
	 * Disable sign up if user is not found.
	 *
	 * @default false
	 */
	disableSignUp?: boolean;
	/**
	 * Rate limit configuration.
	 *
	 * @default {
	 *  window: 60,
	 *  max: 5,
	 * }
	 */
	rateLimit?: {
		window: number;
		max: number;
	};
}

export const magicLink = (options: MagicLinkOptions) => {
	return {
		id: "magic-link",
		endpoints: {
			signInMagicLink: createAuthEndpoint(
				"/sign-in/magic-link",
				{
					method: "POST",
					requireHeaders: true,
					body: z.object({
						email: z
							.string({
								description: "Email address to send the magic link",
							})
							.email(),
						callbackURL: z
							.string({
								description: "URL to redirect after magic link verification",
							})
							.optional(),
					}),
					metadata: {
						openapi: {
							description: "Sign in with magic link",
							responses: {
								200: {
									description: "Success",
									content: {
										"application/json": {
											schema: {
												type: "object",
												properties: {
													status: {
														type: "boolean",
													},
												},
											},
										},
									},
								},
							},
						},
					},
				},
				async (ctx) => {
					const { email } = ctx.body;

					if (options.disableSignUp) {
						const user =
							await ctx.context.internalAdapter.findUserByEmail(email);

						if (!user) {
							throw new APIError("BAD_REQUEST", {
								message: "User not found",
							});
						}
					}

					const verificationToken = generateRandomString(
						32,
						alphabet("a-z", "A-Z"),
					);
					await ctx.context.internalAdapter.createVerificationValue({
						identifier: verificationToken,
						value: email,
						expiresAt: new Date(
							Date.now() + (options.expiresIn || 60 * 5) * 1000,
						),
					});
					const url = `${
						ctx.context.baseURL
					}/magic-link/verify?token=${verificationToken}&callbackURL=${
						ctx.body.callbackURL || "/"
					}`;
					try {
						await options.sendMagicLink(
							{
								email,
								url,
								token: verificationToken,
							},
							ctx.request,
						);
					} catch (e) {
						ctx.context.logger.error("Failed to send magic link", e);
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Failed to send magic link",
						});
					}
					return ctx.json({
						status: true,
					});
				},
			),
			magicLinkVerify: createAuthEndpoint(
				"/magic-link/verify",
				{
					method: "GET",
					query: z.object({
						token: z.string({
							description: "Verification token",
						}),
						callbackURL: z
							.string({
								description:
									"URL to redirect after magic link verification, if not provided will return session",
							})
							.optional(),
					}),
					requireHeaders: true,
					metadata: {
						openapi: {
							description: "Verify magic link",
							responses: {
								200: {
									description: "Success",
									content: {
										"application/json": {
											schema: {
												type: "object",
												properties: {
													session: {
														$ref: "#/components/schemas/Session",
													},
													user: {
														$ref: "#/components/schemas/User",
													},
												},
											},
										},
									},
								},
							},
						},
					},
				},
				async (ctx) => {
					const { token, callbackURL } = ctx.query;
					const toRedirectTo = callbackURL?.startsWith("http")
						? callbackURL
						: callbackURL
							? `${ctx.context.options.baseURL}${callbackURL}`
							: ctx.context.options.baseURL;
					const tokenValue =
						await ctx.context.internalAdapter.findVerificationValue(token);
					if (!tokenValue) {
						throw ctx.redirect(`${toRedirectTo}?error=INVALID_TOKEN`);
					}
					if (tokenValue.expiresAt < new Date()) {
						await ctx.context.internalAdapter.deleteVerificationValue(
							tokenValue.id,
						);
						throw ctx.redirect(`${toRedirectTo}?error=EXPIRED_TOKEN`);
					}
					await ctx.context.internalAdapter.deleteVerificationValue(
						tokenValue.id,
					);
					const email = tokenValue.value;
					const user = await ctx.context.internalAdapter.findUserByEmail(email);
					let userId: string = user?.user.id || "";

					if (!user) {
						if (!options.disableSignUp) {
							const newUser = await ctx.context.internalAdapter.createUser({
								email: email,
								emailVerified: true,
								name: email,
							});
							userId = newUser.id;
							if (!userId) {
								throw ctx.redirect(`${toRedirectTo}?error=USER_NOT_CREATED`);
							}
						} else {
							throw ctx.redirect(`${toRedirectTo}?error=USER_NOT_FOUND`);
						}
					}
					const session = await ctx.context.internalAdapter.createSession(
						userId,
						ctx.headers,
					);
					if (!session) {
						throw ctx.redirect(`${toRedirectTo}?error=SESSION_NOT_CREATED`);
					}
					await setSessionCookie(ctx, {
						session,
						user: user?.user!,
					});
					if (!callbackURL) {
						return ctx.json({
							session,
							user: user?.user!,
						});
					}
					throw ctx.redirect(callbackURL);
				},
			),
		},
		rateLimit: [
			{
				pathMatcher(path) {
					return (
						path.startsWith("/sign-in/magic-link") ||
						path.startsWith("/magic-link/verify")
					);
				},
				window: options.rateLimit?.window || 60,
				max: options.rateLimit?.max || 5,
			},
		],
	} satisfies BetterAuthPlugin;
};
