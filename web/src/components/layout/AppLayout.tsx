import { ServerList } from '../server/ServerList';
import { ChannelList } from '../channel/ChannelList';
import { MessageList } from '../message/MessageList';
import { MessageInput } from '../message/MessageInput';

export function AppLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Server list - narrow left sidebar */}
      <ServerList />

      {/* Channel list - secondary sidebar */}
      <ChannelList />

      {/* Main chat area */}
      <div className="flex min-w-0 flex-1 flex-col">
        <MessageList />
        <MessageInput />
      </div>
    </div>
  );
}
