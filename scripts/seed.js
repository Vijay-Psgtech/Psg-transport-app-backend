import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { ROLES } from '../constants/roles.js';

const credentialsPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.seed-credentials.json');
const days = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

const demoUsers = [
  { name: 'System Admin', email: 'admin@institute.edu', phone: '9876543212', role: ROLES.ADMIN },
  { name: 'Transport Officer', email: 'officer@institute.edu', phone: '9876543213', role: ROLES.TRANSPORT_OFFICER },
  {
    name: 'Ravi Kumar',
    email: 'driver1@institute.edu',
    phone: '9876543210',
    role: ROLES.DRIVER,
    driverProfile: {
      licenseNumber: 'TN3820150012345',
      licenseClass: 'HPMV',
      licenseExpiry: days(900),
      badgeNumber: 'PSV-1042',
      bloodGroup: 'B+',
      experienceYears: 8,
    },
  },
  {
    name: 'Murugan S',
    email: 'driver2@institute.edu',
    phone: '9876543211',
    role: ROLES.DRIVER,
    driverProfile: {
      licenseNumber: 'TN3820120067890',
      licenseClass: 'HMV',
      licenseExpiry: days(20),
      bloodGroup: 'O+',
      experienceYears: 12,
    },
  },
  { name: 'Transport User', email: 'requester@institute.edu', phone: '9876543214', role: ROLES.TRANSPORT_USER },
];

function generatePassword() {
  let password;
  do {
    password = randomBytes(32).toString('base64url');
  } while (!/[A-Za-z]/.test(password) || !/\d/.test(password));
  return password;
}

async function loadCredentials() {
  try {
    const data = JSON.parse(await readFile(credentialsPath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Seed credentials file must contain a JSON object.');
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function saveCredentials(credentials) {
  await writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

if (process.env.NODE_ENV === 'production') {
  throw new Error('Demo accounts cannot be seeded when NODE_ENV=production.');
}
if (!process.env.MONGO_URI) {
  throw new Error('MONGO_URI is not set. Configure it in .env before seeding demo accounts.');
}
const sharedDemoPassword = process.env.DEMO_ACCOUNT_PASSWORD?.trim();
if (
  sharedDemoPassword &&
  (sharedDemoPassword.length < 8 || !/[A-Za-z]/.test(sharedDemoPassword) || !/\d/.test(sharedDemoPassword))
) {
  throw new Error('DEMO_ACCOUNT_PASSWORD must contain at least 8 characters, one letter, and one number.');
}

const credentials = await loadCredentials();
await mongoose.connect(process.env.MONGO_URI);

try {
  for (const demoUser of demoUsers) {
    const existing = await User.findOne({ email: demoUser.email });
    let storedCredentials = credentials[demoUser.email];

    if (existing) {
      const updates = {};
      let passwordUpdated = false;
      if (!existing.phone && demoUser.phone) updates.phone = demoUser.phone;
      if (demoUser.driverProfile && !existing.driverProfile?.licenseNumber) {
        updates.driverProfile = demoUser.driverProfile;
      }
      if (sharedDemoPassword && storedCredentials?.password !== sharedDemoPassword) {
        existing.password = sharedDemoPassword;
        existing.mustChangePassword = true;
        await existing.validate(['password']);
        await existing.save({ validateBeforeSave: false });
        storedCredentials = {
          name: demoUser.name,
          email: demoUser.email,
          phone: demoUser.phone,
          role: demoUser.role,
          password: sharedDemoPassword,
        };
        credentials[demoUser.email] = storedCredentials;
        await saveCredentials(credentials);
        console.log(`Updated temporary demo password: ${demoUser.email}`);
        passwordUpdated = true;
      }
      if (Object.keys(updates).length) {
        await User.updateOne({ _id: existing._id }, { $set: updates });
        console.log(`Updated demo account details: ${demoUser.email}`);
      } else if (!passwordUpdated) {
        console.log(`Exists; password unchanged: ${demoUser.email}`);
      }
      if (!storedCredentials) {
        console.warn(`No saved generated password for ${demoUser.email}; existing password was not reset.`);
      }
      continue;
    }

    const password = sharedDemoPassword || storedCredentials?.password || generatePassword();
    if (!storedCredentials || storedCredentials.password !== password) {
      storedCredentials = {
        name: demoUser.name,
        email: demoUser.email,
        phone: demoUser.phone,
        role: demoUser.role,
        password,
      };
      credentials[demoUser.email] = storedCredentials;
      await saveCredentials(credentials);
    }

    await User.create({ ...demoUser, password, mustChangePassword: true });
    console.log(`Created ${demoUser.role}: ${demoUser.email} | phone ${demoUser.phone} | temporary password ${password}`);
  }
  console.log(`Seed complete. Generated demo credentials are saved in ${credentialsPath}. Keep that file private.`);
} finally {
  await mongoose.disconnect();
}
