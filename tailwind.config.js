/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        page: '#F8F9FC',
        card: '#FFFFFF',
        ink: '#202C40',
        inkSecondary: '#8792A5',
        gold: '#C5A46D',
        chinext: '#426997',
        danger: '#E65B64',
        safe: '#20A97B',
      },
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', 'PingFang SC', 'Hiragino Sans GB',
          'Microsoft YaHei', 'Segoe UI', 'Roboto', 'sans-serif',
        ],
        num: ['"SF Pro Display"', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(32,44,64,0.05), 0 4px 16px rgba(32,44,64,0.06)',
        cardHover: '0 2px 6px rgba(32,44,64,0.07), 0 10px 28px rgba(32,44,64,0.10)',
      },
    },
  },
  plugins: [],
}
