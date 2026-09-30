/** Only the local app's top-level renderer may request desktop pixels. */
export function trustedPreviewSender(event, appUrl) {
  return event.senderFrame === event.sender.mainFrame && event.senderFrame?.url === appUrl;
}
