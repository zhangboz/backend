// backend/services/emailService.mjs
import nodemailer from 'nodemailer';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';

// Create a transporter object using the default SMTP transport
const transporter = nodemailer.createTransport({
  service: 'gmail', // Use the built-in Gmail service
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS, // Use the App Password
  },
});

// Function to send the confirmation email
export const sendConfirmationEmail = async (userEmail, token) => {
  const confirmationUrl = `${BACKEND_URL}/api/login/confirm-email/${token}`;

  const mailOptions = {
    from: `"Homework Help AI" <${process.env.MAIL_USER}>`,
    to: userEmail,
    subject: 'Confirm Your Email for Homework Help AI',
    html: `
      <div style="font-family: sans-serif; text-align: center; padding: 20px;">
        <h2>Welcome to Homework Help AI!</h2>
        <p>Thank you for registering. Please click the button below to confirm your email address.</p>
        <a href="${confirmationUrl}" style="background-color: #007bff; color: white; padding: 14px 25px; text-align: center; text-decoration: none; display: inline-block; border-radius: 5px; margin-top: 20px;">
          Confirm Email
        </a>
        <p style="margin-top: 30px;">If the button doesn't work, copy and paste this link into your browser:</p>
        <p><a href="${confirmationUrl}">${confirmationUrl}</a></p>
        <p style="color: #888;">This link will expire in 1 hour.</p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[Email Service] Confirmation email sent to ${userEmail}`);
  } catch (error) {
    console.error(`[Email Service] Error sending email to ${userEmail}:`, error);
    // In a real app, you might want a more robust error handling/retry mechanism
    throw new Error('Could not send confirmation email.');
  }
};