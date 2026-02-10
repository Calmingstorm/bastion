import { useState } from 'react';
import { ServerList } from '../server/ServerList';
import { ChannelList } from '../channel/ChannelList';
import { MessageList } from '../message/MessageList';
import { MessageInput } from '../message/MessageInput';
import { MemberList } from '../member/MemberList';
import { DMList } from '../dm/DMList';
import { DMChannelHeader } from '../dm/DMChannelHeader';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';

export function AppLayout() {
  const selectedServerId = useServerStore((s) => s.selectedServerId);
  const selectedDMId = useDMStore((s) => s.selectedDMId);
  const [showMembers, setShowMembers] = useState(true);

  const isDMView = !selectedServerId;
  const showChat = isDMView ? !!selectedDMId : true;

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Server list - narrow left sidebar */}
      <ServerList />

      {/* Channel / DM list - secondary sidebar */}
      {isDMView ? <DMList /> : <ChannelList />}

      {/* Main chat area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {isDMView && selectedDMId && <DMChannelHeader />}
        {showChat ? (
          <>
            <MessageList
              onToggleMembers={
                !isDMView ? () => setShowMembers((v) => !v) : undefined
              }
            />
            <MessageInput />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center bg-[var(--bg-primary)]">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--bg-secondary)]">
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-[var(--text-muted)]"
                >
                  <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                Welcome to Bastion
              </h3>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                Select a conversation to start chatting
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Member list - right sidebar (server channels only) */}
      {!isDMView && showMembers && <MemberList />}
    </div>
  );
}
