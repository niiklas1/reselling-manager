

test('backup restore accepts all currencies supported by the account settings', () => {
  const app = read('src/App.tsx')
  assert.match(app, /isSupportedCurrency\(restoredCurrency\)/)
})
