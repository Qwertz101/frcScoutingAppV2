import { useState } from 'react';
import { User } from '../types';
import { Settings, Users, BarChart3, Calendar, ListOrdered, ArrowLeft } from 'lucide-react';
import { ScouterManagement } from './ScouterManagement';
import { fetchServerScouters, performFullRefresh } from '../services/syncService';
import { SyncControl } from './SyncControl';
import { DataAnalysis } from './DataAnalysis';
import { MatchSelection } from './MatchSelection';
import { ScoutShell } from './scout/ScoutShell';

interface AdminPanelProps {
  user: User;
  onLogout: () => void;
}

type AdminView = 'menu' | 'scouters' | 'analysis' | 'matches' | 'picklist';

export function AdminPanel({ user, onLogout }: AdminPanelProps) {
  const [currentView, setCurrentView] = useState<AdminView>('menu');

  const menuItems = [
    {
      id: 'scouters',
      title: 'Assign Scouters',
      description: 'Manage scouter assignments for matches',
      icon: Users,
      color: 'bg-blue-600 hover:bg-blue-700',
    },
    {
      id: 'analysis',
      title: 'Analyze Data',
      description: 'View and filter scouting data',
      icon: BarChart3,
      color: 'bg-green-600 hover:bg-green-700',
    },
    {
      id: 'matches',
      title: 'Select Matches',
      description: 'Import matches from The Blue Alliance',
      icon: Calendar,
      color: 'bg-purple-600 hover:bg-purple-700',
    },
    {
      id: 'picklist',
      title: 'Scout Workspace',
      description: 'Field ranking, picklist, analysis, strategy and forecast',
      icon: ListOrdered,
      color: 'bg-cyan-600 hover:bg-cyan-700',
    },
  ];

  if (currentView === 'scouters') {
    return <ScouterManagement onBack={() => setCurrentView('menu')} />;
  }

  if (currentView === 'analysis') {
    return <DataAnalysis onBack={() => setCurrentView('menu')} />;
  }

  if (currentView === 'matches') {
    return <MatchSelection onBack={() => setCurrentView('menu')} />;
  }

  if (currentView === 'picklist') {
    return <ScoutShell onBack={() => setCurrentView('menu')} />;
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-red-600 rounded-full flex items-center justify-center">
                <Settings className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Admin Panel</h1>
                <p className="text-gray-600">Welcome, {user.username}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <SyncControl onSync={() => performFullRefresh()} onCheck={() => fetchServerScouters()} />
              <button
                onClick={() => { performFullRefresh().catch(() => {}); fetchServerScouters().catch(() => {}); }}
                className="ml-2 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-md"
              >
                Refresh
              </button>
              <button
                onClick={onLogout}
                className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
                Logout
              </button>
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {menuItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setCurrentView(item.id as AdminView)}
                className={`${item.color} text-white p-6 rounded-lg shadow-md hover:shadow-lg transition-all duration-200 text-left`}
              >
                <Icon className="w-8 h-8 mb-4" />
                <h3 className="text-xl font-bold mb-2">{item.title}</h3>
                <p className="text-blue-100 text-sm">{item.description}</p>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}