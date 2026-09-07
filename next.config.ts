import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts')

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
  images: {
    remotePatterns: [{ protocol: 'https' as const, hostname: '**.supabase.co' }],
  },
  experimental: {
    serverActions: { bodySizeLimit: '12mb' as const },
  },
  // lib/legal.ts reads legal/*.md from disk at request time; on Vercel only traced
  // files ship with the function, so include them explicitly for every route.
  outputFileTracingIncludes: { '/**/*': ['./legal/**/*'] },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
}

export default withNextIntl(nextConfig)
