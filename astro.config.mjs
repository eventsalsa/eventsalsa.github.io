// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const owner = process.env.GITHUB_REPOSITORY_OWNER ?? 'eventsalsa';
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const isRootPagesRepo = repo === `${owner}.github.io`;
const base = process.env.GITHUB_PAGES === 'true' && repo && !isRootPagesRepo ? `/${repo}` : '/';

// https://astro.build/config
export default defineConfig({
	site: `https://${owner}.github.io`,
	base,
	integrations: [
		starlight({
			title: 'eventsalsa',
			description: 'Website and documentation for the eventsalsa event sourcing bundle for Go.',
			tagline: 'A component-based stack for event sourcing in Go.',
			lastUpdated: true,
			disable404Route: true,
			customCss: ['/src/styles/design-theme.css'],
			components: {
				Header: './src/components/starlight/Header.astro',
			},
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/eventsalsa/store' }],
			sidebar: [
				{
					label: 'Documentation',
					items: [
						{ label: 'Overview', slug: 'documentation' },
						{ label: 'Getting started', slug: 'documentation/getting-started' },
					],
				},
				{
					label: 'Components',
					items: [
						{ label: 'Store', slug: 'documentation/components/store' },
						{ label: 'Worker', slug: 'documentation/components/worker' },
						{ label: 'Encryption', slug: 'documentation/components/encryption' },
					],
				},
				{
					label: 'Project',
					items: [{ label: 'Changelog', slug: 'documentation/project/changelog' }],
				},
			],
		}),
	],
});
