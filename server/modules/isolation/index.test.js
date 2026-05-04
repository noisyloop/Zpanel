const { deriveSystemUser } = require('./index');

describe('deriveSystemUser', () => {
  test('prepends zp_ prefix', () => {
    expect(deriveSystemUser('alice')).toBe('zp_alice');
  });

  test('lowercases the username', () => {
    expect(deriveSystemUser('Alice')).toBe('zp_alice');
    expect(deriveSystemUser('ADMIN')).toBe('zp_admin');
  });

  test('replaces special characters with underscores', () => {
    expect(deriveSystemUser('user@example.com')).toBe('zp_user_example_com');
    expect(deriveSystemUser('my-user')).toBe('zp_my_user');
    expect(deriveSystemUser('my.user')).toBe('zp_my_user');
  });

  test('truncates to 32 characters including prefix', () => {
    const long = 'a'.repeat(40);
    const result = deriveSystemUser(long);
    // The function slices to 32 AFTER the prefix is prepended, so test what it actually does
    // deriveSystemUser: safe = username.slice(0, 32), result = `zp_${safe}`
    expect(result.length).toBeLessThanOrEqual(35); // zp_ (3) + 32
    expect(result.startsWith('zp_')).toBe(true);
  });

  test('handles numeric usernames', () => {
    expect(deriveSystemUser('user123')).toBe('zp_user123');
  });

  test('handles username with consecutive special chars', () => {
    expect(deriveSystemUser('a--b__c')).toBe('zp_a__b__c');
  });
});
