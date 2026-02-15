import { useState, useEffect, useCallback } from 'react';
import { ServerList } from '../server/ServerList';
import { ChannelList } from '../channel/ChannelList';
import { MessageList } from '../message/MessageList';
import { MessageInput } from '../message/MessageInput';
import { MemberList } from '../member/MemberList';
import { DMList } from '../dm/DMList';
import { UnifiedSidebar } from '../sidebar/UnifiedSidebar';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { useNotifications } from '../../hooks/useNotifications';
import { useFeatureStore } from '../../stores/featureStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useBreakpoints } from '../../hooks/useMediaQuery';
import { useActivityPresence } from '../../hooks/useActivityPresence';

export function AppLayout() {
  useNotifications();
  useActivityPresence();
  const fetchFeatures = useFeatureStore((s) => s.fetchFeatures);
  useEffect(() => { fetchFeatures(); }, [fetchFeatures]);
  const selectedServerId = useServerStore((s) => s.selectedServerId);
  const selectedChannelId = useServerStore((s) => s.selectedChannelId);
  const selectedDMId = useDMStore((s) => s.selectedDMId);
  const layout = useLayoutStore((s) => s.layout);
  const { isMobile, isDesktop } = useBreakpoints();
  const [showMembers, setShowMembers] = useState(true);
  const [showSidebar, setShowSidebar] = useState(false);

  // Auto-close sidebar on mobile when navigating to a channel/DM
  useEffect(() => {
    if (isMobile) {
      setShowSidebar(false);
    }
  }, [selectedChannelId, selectedDMId, isMobile]);

  // Hide members on non-desktop by default
  useEffect(() => {
    setShowMembers(isDesktop);
  }, [isDesktop]);

  const handleToggleSidebar = useCallback(() => {
    setShowSidebar((v) => !v);
  }, []);

  const handleToggleMembers = useCallback(() => {
    setShowMembers((v) => !v);
  }, []);

  // ─── Modern Layout ───
  if (layout === 'modern') {
    // In modern mode, DM is active when selectedDMId is set and no channel is selected
    const isDM = !!selectedDMId && !selectedChannelId;

    return (
      <div className="flex h-full w-full overflow-hidden safe-area-top safe-area-bottom">
        {/* Mobile sidebar overlay */}
        {isMobile && showSidebar && (
          <div
            className="fixed inset-0 z-30 bg-black/50"
            onClick={() => setShowSidebar(false)}
          />
        )}

        {/* Unified Sidebar */}
        <div className={
          isMobile
            ? `fixed left-0 top-0 z-40 h-full safe-area-pad bg-[var(--bg-secondary)] transition-transform duration-200 ${showSidebar ? 'translate-x-0' : '-translate-x-full'}`
            : ''
        }>
          <UnifiedSidebar />
        </div>

        {/* Main chat area */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <MessageList
            onToggleMembers={!isDM ? handleToggleMembers : undefined}
            onToggleSidebar={isMobile ? handleToggleSidebar : undefined}
          />
          <MessageInput />
        </div>

        {/* Member list - right sidebar (server channels only) */}
        {!isDM && showMembers && !isMobile && <MemberList />}

        {/* Mobile member list overlay */}
        {!isDM && showMembers && isMobile && (
          <>
            <div
              className="fixed inset-0 z-30 bg-black/50"
              onClick={() => setShowMembers(false)}
            />
            <div className="fixed right-0 top-0 z-40 h-full safe-area-pad bg-[var(--bg-secondary)]">
              <MemberList />
            </div>
          </>
        )}
      </div>
    );
  }

  // ─── Classic Layout (unchanged) ───
  const isDMView = !selectedServerId;
  const showChat = isDMView ? !!selectedDMId : true;

  return (
    <div className="flex h-full w-full overflow-hidden safe-area-top safe-area-bottom">
      {/* Mobile sidebar overlay */}
      {isMobile && showSidebar && (
        <div
          className="fixed inset-0 z-30 bg-black/50"
          onClick={() => setShowSidebar(false)}
        />
      )}

      {/* Server list - narrow left sidebar */}
      <div className={
        isMobile
          ? `fixed left-0 top-0 z-40 h-full safe-area-pad bg-[var(--bg-tertiary)] transition-transform duration-200 ${showSidebar ? 'translate-x-0' : '-translate-x-full'}`
          : ''
      }>
        <ServerList />
      </div>

      {/* Channel / DM list - secondary sidebar */}
      <div className={
        isMobile
          ? `fixed left-[72px] top-0 z-40 h-full safe-area-pad bg-[var(--bg-secondary)] transition-transform duration-200 ${showSidebar ? 'translate-x-0' : '-translate-x-[calc(100%+72px)]'}`
          : ''
      }>
        {isDMView ? <DMList /> : <ChannelList />}
      </div>

      {/* Main chat area */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {showChat ? (
          <>
            <MessageList
              onToggleMembers={!isDMView ? handleToggleMembers : undefined}
              onToggleSidebar={isMobile ? handleToggleSidebar : undefined}
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
                {isMobile ? (
                  <button onClick={handleToggleSidebar} className="text-[var(--accent)] hover:underline">
                    Open sidebar
                  </button>
                ) : (
                  'Select a conversation to start chatting'
                )}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Member list - right sidebar (server channels only) */}
      {!isDMView && showMembers && !isMobile && <MemberList />}

      {/* Mobile member list overlay */}
      {!isDMView && showMembers && isMobile && (
        <>
          <div
            className="fixed inset-0 z-30 bg-black/50"
            onClick={() => setShowMembers(false)}
          />
          <div className="fixed right-0 top-0 z-40 h-full safe-area-pad bg-[var(--bg-secondary)]">
            <MemberList />
          </div>
        </>
      )}
    </div>
  );
}
